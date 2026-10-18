import { Hono } from "hono";
import type { AppEnv } from "./index";
import { attachPhotos } from "./meals";
import type { Meal } from "../shared/meals";
import {
  DIGEST_DAYS,
  PROMPT_VERSION,
  batchKey,
  buildPrompt,
  computeTrend,
  photoFileName,
  type DigestEntry,
  type RememberedFood,
} from "../shared/prompt";
import { isUlid, ulid } from "../shared/ulid";

// Most chat apps take up to 20 attachments in one message. Verify on the phone (SPEC §12).
export const MAX_PHOTOS_PER_BATCH = 20;

export type BatchView = {
  id: string;
  created_at: string;
  status: "open" | "imported" | "abandoned";
  prompt: string;
  entries: { key: string; meal: Meal; files: { photo_id: string; name: string }[] }[];
};

export const batches = new Hono<AppEnv>();

// Meals not yet analyzed (a skipped analysis doesn't count) and not in an open batch.
const PENDING_SQL = `
  SELECT m.id, m.taken_at, m.tz, m.meal_type, m.note FROM meals m
  WHERE m.user_id = ?1 AND m.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.user_id = ?1 AND a.meal_id = m.id AND a.skipped = 0)
    AND NOT EXISTS (SELECT 1 FROM batches b, json_each(b.key_map) k
                    WHERE b.user_id = ?1 AND b.status = 'open' AND k.value = m.id)`;

batches.get("/batches/pending-meals", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(`${PENDING_SQL} ORDER BY m.taken_ms LIMIT 200`)
    .bind(user.id)
    .all<Omit<Meal, "photos">>();
  return c.json({ meals: await attachPhotos(c.env.DB, user.id, results), max_photos: MAX_PHOTOS_PER_BATCH });
});

// POST /api/batches {meal_ids} — freezes the selected meals into a batch with its prompt.
batches.post("/batches", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ meal_ids?: unknown }>().catch(() => ({}) as { meal_ids?: unknown });
  const ids = body.meal_ids;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUlid) || new Set(ids).size !== ids.length) {
    return c.json({ error: "bad_request" }, 400);
  }
  const { results: rows } = await c.env.DB.prepare(
    `${PENDING_SQL} AND m.id IN (SELECT value FROM json_each(?2)) ORDER BY m.taken_ms`,
  )
    .bind(user.id, JSON.stringify(ids))
    .all<Omit<Meal, "photos">>();
  if (rows.length !== ids.length) return c.json({ error: "not_pending" }, 409); // gone, analyzed, or in another batch
  const meals = await attachPhotos(c.env.DB, user.id, rows);
  const photoCount = meals.reduce((n, m) => n + m.photos.length, 0);
  if (photoCount > MAX_PHOTOS_PER_BATCH) return c.json({ error: "too_many_photos", max: MAX_PHOTOS_PER_BATCH }, 413);

  const [notes, foods, digest] = await Promise.all([
    c.env.DB.prepare("SELECT body FROM notes WHERE user_id = ?1 ORDER BY created_at").bind(user.id).all<{ body: string }>(),
    c.env.DB.prepare(
      "SELECT code, name, serving, kcal, protein_g, carbs_g, fat_g FROM foods WHERE user_id = ?1 AND status = 'active' ORDER BY CAST(substr(code, 2) AS INTEGER)",
    )
      .bind(user.id)
      .all<RememberedFood>(),
    loadDigest(c.env.DB, user.id),
  ]);

  const id = ulid();
  const keyMap = Object.fromEntries(meals.map((m, i) => [batchKey(i), m.id]));
  const prompt = buildPrompt({
    batchId: id,
    notes: notes.results.map((n) => n.body),
    foods: foods.results,
    digest,
    trend: computeTrend(digest, Date.now()),
    meals: meals.map((m, i) => ({ key: batchKey(i), ...m })),
  });
  await c.env.DB.prepare(
    `INSERT INTO batches (id, user_id, created_at, prompt_version, prompt_text, key_map, active_codes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, user.id, new Date().toISOString(), PROMPT_VERSION, prompt, JSON.stringify(keyMap), JSON.stringify(foods.results.map((f) => f.code)))
    .run();
  const [batch] = await viewBatches(c.env.DB, user.id, "id = ?2", id);
  return c.json({ batch }, 201);
});

// GET /api/batches?status=open — open batches, ready to hand over (again) or import.
batches.get("/batches", async (c) => {
  const user = c.get("user");
  const status = c.req.query("status") ?? "open";
  if (!["open", "imported", "abandoned"].includes(status)) return c.json({ error: "bad_request" }, 400);
  return c.json({ batches: await viewBatches(c.env.DB, user.id, "status = ?2", status) });
});

// POST /api/batches/:id/abandon — gives up on an open batch; its meals become pending again.
batches.post("/batches/:id/abandon", async (c) => {
  const user = c.get("user");
  const res = await c.env.DB.prepare("UPDATE batches SET status = 'abandoned' WHERE id = ?1 AND user_id = ?2 AND status = 'open'")
    .bind(c.req.param("id"), user.id)
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

async function viewBatches(db: D1Database, userId: string, where: string, arg: string): Promise<BatchView[]> {
  const { results } = await db
    .prepare(`SELECT id, created_at, status, prompt_text, key_map FROM batches WHERE user_id = ?1 AND ${where} ORDER BY created_at DESC LIMIT 50`)
    .bind(userId, arg)
    .all<{ id: string; created_at: string; status: BatchView["status"]; prompt_text: string; key_map: string }>();
  const out: BatchView[] = [];
  for (const b of results) {
    const keyMap = JSON.parse(b.key_map) as Record<string, string>;
    const { results: rows } = await db
      .prepare("SELECT id, taken_at, tz, meal_type, note FROM meals WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))")
      .bind(userId, JSON.stringify(Object.values(keyMap)))
      .all<Omit<Meal, "photos">>();
    const meals = new Map((await attachPhotos(db, userId, rows)).map((m) => [m.id, m]));
    out.push({
      id: b.id,
      created_at: b.created_at,
      status: b.status,
      prompt: b.prompt_text,
      entries: Object.entries(keyMap)
        .filter(([, mealId]) => meals.has(mealId)) // a meal deleted after batching drops out
        .map(([key, mealId]) => {
          const meal = meals.get(mealId)!;
          return { key, meal, files: meal.photos.map((p) => ({ photo_id: p.id, name: photoFileName(key, p.position, meal.taken_at) })) };
        }),
    });
  }
  return out;
}

// One entry per meal analyzed in the last DIGEST_DAYS days (its latest non-skipped analysis).
async function loadDigest(db: D1Database, userId: string): Promise<DigestEntry[]> {
  const since = Date.now() - DIGEST_DAYS * 86_400_000;
  const { results } = await db
    .prepare(
      `SELECT m.taken_at, m.meal_type, a.payload FROM meals m
       JOIN analyses a ON a.id = (SELECT id FROM analyses WHERE user_id = ?1 AND meal_id = m.id AND skipped = 0
                                  ORDER BY created_at DESC LIMIT 1)
       WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND m.taken_ms >= ?2
       ORDER BY m.taken_ms DESC`,
    )
    .bind(userId, since)
    .all<{ taken_at: string; meal_type: DigestEntry["meal_type"]; payload: string }>();
  return results.map((r) => {
    const p = JSON.parse(r.payload) as Partial<DigestEntry> & { foods_used?: unknown };
    const n = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      taken_at: r.taken_at,
      meal_type: r.meal_type,
      description: typeof p.description === "string" ? p.description : "meal",
      kcal: n(p.kcal),
      protein_g: n(p.protein_g),
      carbs_g: n(p.carbs_g),
      fat_g: n(p.fat_g),
      foods_used: Array.isArray(p.foods_used) ? p.foods_used.filter((x): x is string => typeof x === "string") : [],
    };
  });
}
