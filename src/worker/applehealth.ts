import { Hono } from "hono";
import type { AppEnv } from "./index";
import { ulid } from "../shared/ulid";

// Apple Health export (D34). A web app can't write to HealthKit, so an iOS Shortcut does:
// it asks /shortcut/meals for the meals not yet sent, logs each as Health samples at the
// meal's time, then posts to the run's done URL so they're never sent again. A Shortcut
// can add samples but never change or delete them, so only settled estimates go out.

// An estimate is settled when nothing is still changing it: analyzed, no question waiting,
// no run queued, and unchanged for this long.
export const SETTLED_MS = 60 * 60_000;
const MAX_PER_RUN = 200; // the first run sends every past meal; a cap keeps one run sane

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const hashKey = async (key: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));

// ── Managing the key, from Settings (signed in) ──────────────────────────────

export const appleHealth = new Hono<AppEnv>();

// GET /api/apple-health — whether a key exists, the last run, and what's waiting.
appleHealth.get("/apple-health", async (c) => {
  const user = c.get("user");
  const key = await c.env.DB.prepare(
    "SELECT created_at, last_used_at FROM health_keys WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1",
  )
    .bind(user.id)
    .first<{ created_at: string; last_used_at: string | null }>();
  const last = await c.env.DB.prepare(
    "SELECT done_at, json_array_length(meal_ids) AS meals FROM health_runs WHERE user_id = ?1 AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 1",
  )
    .bind(user.id)
    .first<{ done_at: string; meals: number }>();
  const counts = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM health_exports WHERE user_id = ?1) AS sent,
       (SELECT COUNT(*) FROM health_exports e WHERE e.user_id = ?1 AND e.analysis_id !=
          (SELECT id FROM analyses a WHERE a.user_id = ?1 AND a.meal_id = e.meal_id AND a.skipped = 0 ORDER BY a.created_at DESC LIMIT 1)) AS changed_after`,
  )
    .bind(user.id)
    .first<{ sent: number; changed_after: number }>();
  const waiting = (await settledMeals(c.env.DB, user.id, Date.now())).length;
  return c.json({ key: key ?? null, last_run: last ?? null, sent: counts?.sent ?? 0, changed_after: counts?.changed_after ?? 0, waiting });
});

// POST /api/apple-health/key — a new key for the Shortcut, shown once. Replaces any old one.
appleHealth.post("/apple-health/key", async (c) => {
  const user = c.get("user");
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = "bb_" + btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE health_keys SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL").bind(user.id, now),
    c.env.DB.prepare("INSERT INTO health_keys (id, user_id, key_hash, created_at) VALUES (?1, ?2, ?3, ?4)").bind(ulid(), user.id, await hashKey(key), now),
  ]);
  return c.json({ key }, 201);
});

// DELETE /api/apple-health/key — the Shortcut stops working.
appleHealth.delete("/apple-health/key", async (c) => {
  await c.env.DB.prepare("UPDATE health_keys SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL")
    .bind(c.get("user").id, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});

// ── What the Shortcut calls (its key, no session) ───────────────────────────

type ShortcutEnv = { Bindings: Env; Variables: { userId: string } };
export const shortcut = new Hono<ShortcutEnv>();

shortcut.use("*", async (c, next) => {
  const key = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const row = key
    ? await c.env.DB.prepare("SELECT id, user_id FROM health_keys WHERE key_hash = ?1 AND revoked_at IS NULL").bind(await hashKey(key)).first<{ id: string; user_id: string }>()
    : null;
  if (!row) return c.json({ error: "bad_key", message: "This Shortcut's key isn't valid. Make a new one in Bitebook → Settings → Apple Health." }, 401);
  await c.env.DB.prepare("UPDATE health_keys SET last_used_at = ?2 WHERE id = ?1").bind(row.id, new Date().toISOString()).run();
  c.set("userId", row.user_id);
  await next();
});

// GET /shortcut/meals — the settled meals not yet sent, oldest first, shaped for Shortcuts:
// plain numbers, a date it can read, fiber only when the estimate has one. Opens a run.
shortcut.get("/meals", async (c) => {
  const userId = c.get("userId");
  const meals = (await settledMeals(c.env.DB, userId, Date.now())).slice(0, MAX_PER_RUN);
  const run = ulid();
  await c.env.DB.prepare("INSERT INTO health_runs (id, user_id, meal_ids, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(run, userId, JSON.stringify(meals.map((m) => m.meal_id)), new Date().toISOString())
    .run();
  const origin = new URL(c.req.url).origin;
  return c.json({
    count: meals.length,
    done_url: `${origin}/shortcut/done/${run}`,
    meals: meals.map((m) => ({
      id: m.meal_id,
      // Written out, because "Get Dates from Input" read only the day from ISO 8601 and put
      // every sample at noon. The meal's local time, which is the phone's unless it has
      // changed zones since.
      date: shortcutDate(m.taken_at),
      date_iso: m.taken_at, // the exact instant, with its offset
      kcal: round(m.kcal),
      protein_g: round(m.protein_g),
      carbs_g: round(m.carbs_g),
      fat_g: round(m.fat_g),
      ...(m.fiber_g === null ? {} : { fiber_g: round(m.fiber_g) }),
    })),
  });
});

// POST /shortcut/done/:run — the Shortcut logged the run's meals: record what was sent.
shortcut.post("/done/:run", async (c) => {
  const userId = c.get("userId");
  const run = await c.env.DB.prepare("SELECT meal_ids, done_at FROM health_runs WHERE id = ?1 AND user_id = ?2")
    .bind(c.req.param("run"), userId)
    .first<{ meal_ids: string; done_at: string | null }>();
  if (!run) return c.json({ error: "not_found" }, 404);
  if (run.done_at) return c.json({ ok: true, already: true });
  const ids = JSON.parse(run.meal_ids) as string[];
  // The values as they were handed out are the meals' newest estimates, unless one changed
  // in the minutes the Shortcut ran; recording the current one is close enough to be honest.
  const latest = (await settledMeals(c.env.DB, userId, Date.now(), ids, true)).filter((m) => ids.includes(m.meal_id));
  const now = new Date().toISOString();
  await c.env.DB.batch([
    ...latest.map((m) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO health_exports (meal_id, user_id, analysis_id, run_id, values_json, exported_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      ).bind(m.meal_id, userId, m.analysis_id, c.req.param("run"), JSON.stringify({ kcal: m.kcal, protein_g: m.protein_g, carbs_g: m.carbs_g, fat_g: m.fat_g, fiber_g: m.fiber_g }), now),
    ),
    c.env.DB.prepare("UPDATE health_runs SET done_at = ?2 WHERE id = ?1").bind(c.req.param("run"), now),
  ]);
  return c.json({ ok: true, logged: latest.length });
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// e.g. "October 26, 2026 at 9:47 PM"
export function shortcutDate(iso: string) {
  const h = Number(iso.slice(11, 13));
  const time = `${h % 12 || 12}:${iso.slice(14, 16)} ${h < 12 ? "AM" : "PM"}`;
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)} at ${time}`;
}

const round = (v: number | null) => (v === null ? 0 : Math.round(v * 10) / 10);

type Settled = {
  meal_id: string;
  taken_at: string;
  analysis_id: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
};

// Meals whose newest estimate has settled and that haven't been sent. With `ids` and
// `anyAge`, just those meals' newest estimates, settled or not (for recording a run).
export async function settledMeals(db: D1Database, userId: string, now: number, ids?: string[], anyAge = false): Promise<Settled[]> {
  const { results } = await db
    .prepare(
      `SELECT m.id AS meal_id, m.taken_at, a.id AS analysis_id, a.payload, a.created_at AS analyzed_at
       FROM meals m
       JOIN analyses a ON a.id = (SELECT id FROM analyses x WHERE x.user_id = ?1 AND x.meal_id = m.id AND x.skipped = 0
                                  ORDER BY x.created_at DESC LIMIT 1)
       WHERE m.user_id = ?1 AND m.deleted_at IS NULL
         AND (CASE WHEN ?3 IS NULL
                THEN NOT EXISTS (SELECT 1 FROM health_exports e WHERE e.user_id = ?1 AND e.meal_id = m.id)
                ELSE m.id IN (SELECT value FROM json_each(?3)) END)
         AND (?4 = 1 OR (a.created_at <= ?2
           AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.user_id = ?1 AND q.meal_id = m.id AND q.answer IS NULL)
           AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.user_id = ?1 AND j.meal_id = m.id AND j.status IN ('queued','running'))))
       ORDER BY m.taken_ms`,
    )
    .bind(userId, new Date(now - SETTLED_MS).toISOString(), ids ? JSON.stringify(ids) : null, anyAge ? 1 : 0)
    .all<{ meal_id: string; taken_at: string; analysis_id: string; payload: string; analyzed_at: string }>();
  return results.map((r) => {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : null);
    return { meal_id: r.meal_id, taken_at: r.taken_at, analysis_id: r.analysis_id, kcal: n("kcal"), protein_g: n("protein_g"), carbs_g: n("carbs_g"), fat_g: n("fat_g"), fiber_g: n("fiber_g") };
  });
}
