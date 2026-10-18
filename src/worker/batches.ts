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
import { extractJson, validateReply } from "../shared/reply";
import { isUlid, ulid } from "../shared/ulid";

// Most chat apps take up to 20 attachments in one message. Verify on the phone (SPEC §12).
export const MAX_PHOTOS_PER_BATCH = 20;

export type BatchView = {
  id: string;
  created_at: string;
  status: "open" | "imported" | "abandoned";
  prompt: string;
  reply_model: string | null;
  reply_model_reported: string | null;
  imported_at: string | null;
  summary: { text: string; suggestion: string | null } | null;
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

// POST /api/batches/:id/import {reply, model} — the pasted reply, validated all-or-nothing
// (SPEC §6). Stores one analysis per meal, applies remembered-food changes, closes the batch.
batches.post("/batches/:id/import", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ reply?: unknown; model?: unknown }>().catch(() => ({}) as { reply?: unknown; model?: unknown });
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (typeof body.reply !== "string" || !body.reply.trim()) return c.json({ errors: ["Paste the reply first."] }, 422);
  if (!model || model.length > 80) return c.json({ errors: ["Say which model wrote the reply."] }, 422);

  const batch = await c.env.DB.prepare(
    "SELECT id, status, prompt_version, key_map, active_codes FROM batches WHERE id = ?1 AND user_id = ?2",
  )
    .bind(c.req.param("id"), user.id)
    .first<{ id: string; status: string; prompt_version: string; key_map: string; active_codes: string }>();
  if (!batch) return c.json({ errors: ["This batch doesn't exist."] }, 404);
  if (batch.status !== "open") return c.json({ errors: [`This batch is already ${batch.status}.`] }, 409);
  const keyMap = JSON.parse(batch.key_map) as Record<string, string>;

  let raw: unknown;
  try {
    raw = extractJson(body.reply);
  } catch (e) {
    return c.json({ errors: [(e as Error).message] }, 422);
  }
  const { reply, errors } = validateReply(raw, { id: batch.id, keys: Object.keys(keyMap), activeCodes: JSON.parse(batch.active_codes) });
  if (!reply) return c.json({ errors }, 422);

  // A meal purged since batching has no row to hang an analysis on; skip just that one.
  const { results: existing } = await c.env.DB.prepare(
    "SELECT id FROM meals WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
  )
    .bind(user.id, JSON.stringify(Object.values(keyMap)))
    .all<{ id: string }>();
  const present = new Set(existing.map((m) => m.id));

  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  for (const m of reply.meals) {
    const mealId = keyMap[m.key];
    if (!present.has(mealId)) continue;
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO analyses (id, user_id, meal_id, batch_id, model, prompt_version, schema_version, skipped, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      ).bind(ulid(), user.id, mealId, batch.id, model, batch.prompt_version, reply.schema, m.skipped ? 1 : 0, JSON.stringify(m), now),
    );
  }
  const maxCode = await c.env.DB.prepare("SELECT MAX(CAST(substr(code, 2) AS INTEGER)) AS n FROM foods WHERE user_id = ?1")
    .bind(user.id)
    .first<{ n: number | null }>();
  let next = (maxCode?.n ?? 0) + 1;
  const remembered: { action: string; code: string; name: string }[] = [];
  for (const r of reply.remember) {
    if (r.action === "add") {
      const code = `F${next++}`;
      remembered.push({ action: "add", code, name: r.name });
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO foods (id, user_id, code, name, serving, kcal, protein_g, carbs_g, fat_g, source_batch_id, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
        ).bind(ulid(), user.id, code, r.name, r.serving, r.kcal, r.protein_g, r.carbs_g, r.fat_g, batch.id, now),
      );
    } else if (r.action === "update") {
      remembered.push({ action: "update", code: r.code!, name: r.name });
      stmts.push(
        c.env.DB.prepare(
          `UPDATE foods SET name = ?3, serving = ?4, kcal = ?5, protein_g = ?6, carbs_g = ?7, fat_g = ?8,
             source_batch_id = ?9, updated_at = ?10 WHERE user_id = ?1 AND code = ?2`,
        ).bind(user.id, r.code, r.name, r.serving, r.kcal, r.protein_g, r.carbs_g, r.fat_g, batch.id, now),
      );
    } else {
      remembered.push({ action: "retire", code: r.code!, name: r.name });
      stmts.push(
        c.env.DB.prepare(
          "UPDATE foods SET status = 'retired', retired_at = ?3, source_batch_id = ?4, updated_at = ?3 WHERE user_id = ?1 AND code = ?2",
        ).bind(user.id, r.code, now, batch.id),
      );
    }
  }
  stmts.push(
    c.env.DB.prepare(
      `UPDATE batches SET status = 'imported', reply_raw = ?3, reply_model = ?4, summary = ?5, imported_at = ?6,
         reply_model_reported = ?7
       WHERE id = ?1 AND user_id = ?2`,
    ).bind(batch.id, user.id, body.reply, model, JSON.stringify(reply.summary), now, reply.model),
  );
  await c.env.DB.batch(stmts); // one transaction: all of it lands, or none of it

  return c.json({
    ok: true,
    analyzed: reply.meals.filter((m) => !m.skipped).length,
    skipped: reply.meals.filter((m) => m.skipped).map((m) => ({ key: m.key, reason: m.skip_reason })),
    remembered,
    summary: reply.summary,
  });
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
    .prepare(
      `SELECT id, created_at, status, prompt_text, key_map, reply_model, reply_model_reported, imported_at, summary FROM batches
       WHERE user_id = ?1 AND ${where} ORDER BY created_at DESC LIMIT 50`,
    )
    .bind(userId, arg)
    .all<{
      id: string;
      created_at: string;
      status: BatchView["status"];
      prompt_text: string;
      key_map: string;
      reply_model: string | null;
      reply_model_reported: string | null;
      imported_at: string | null;
      summary: string | null;
    }>();
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
      reply_model: b.reply_model,
      reply_model_reported: b.reply_model_reported,
      imported_at: b.imported_at,
      summary: b.summary ? JSON.parse(b.summary) : null,
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
