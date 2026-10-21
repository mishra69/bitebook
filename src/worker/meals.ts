import { Hono } from "hono";
import type { AppEnv } from "./index";
import { isUlid } from "../shared/ulid";
import { MEAL_TYPES, photoKey, type Analysis, type DeletedMeal, type Meal, type NewMeal } from "../shared/meals";
import { PURGE_AFTER_DAYS } from "./purge";

// Uploads happen in two steps so a flaky connection never leaves a half-saved meal:
// each photo's two files are PUT on their own (retryable, idempotent), then the meal
// is committed once every file is confirmed in R2 with the expected size and SHA-256.
const MAX_ORIGINAL = 40 * 1024 * 1024;
const MAX_DISPLAY = 4 * 1024 * 1024;
const MAX_NOTE = 2000;
const MAX_PHOTOS = 10;

export const meals = new Hono<AppEnv>();

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
const isIsoWithOffset = (s: unknown): s is string =>
  typeof s === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z)$/.test(s) && !Number.isNaN(Date.parse(s));

// PUT /api/photos/:id/original|display — headers: Content-Type, X-Sha256, X-Taken-At
meals.put("/photos/:id/:kind{original|display}", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const kind = c.req.param("kind") as "original" | "display";
  const sha = c.req.header("X-Sha256");
  const takenAt = c.req.header("X-Taken-At");
  const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!isUlid(id) || !isSha(sha) || !isIsoWithOffset(takenAt)) return c.json({ error: "bad_request" }, 400);
  if (kind === "original" ? !mime.startsWith("image/") : mime !== "image/jpeg") return c.json({ error: "bad_type" }, 415);

  // Once a photo belongs to a committed meal its files are never replaced.
  const existing = await c.env.DB.prepare("SELECT 1 FROM photos WHERE id = ?1 AND user_id = ?2").bind(id, user.id).first();
  if (existing) return c.json({ ok: true, already: true });

  const body = await c.req.arrayBuffer();
  if (body.byteLength === 0 || body.byteLength > (kind === "original" ? MAX_ORIGINAL : MAX_DISPLAY)) {
    return c.json({ error: "bad_size" }, 413);
  }
  if (hex(await crypto.subtle.digest("SHA-256", body)) !== sha) return c.json({ error: "checksum_mismatch" }, 422);

  await c.env.PHOTOS.put(photoKey(user.id, kind, id, takenAt, mime), body, {
    sha256: sha,
    httpMetadata: { contentType: mime },
  });
  return c.json({ ok: true });
});

// POST /api/meals — commit a meal whose photo files are already uploaded. Idempotent.
meals.post("/meals", async (c) => {
  const user = c.get("user");
  const m = await c.req.json<NewMeal>().catch(() => null);
  const problem = validate(m);
  if (problem) return c.json({ error: "bad_request", detail: problem }, 400);
  const meal = m!;

  const existing = await c.env.DB.prepare("SELECT 1 FROM meals WHERE id = ?1 AND user_id = ?2").bind(meal.id, user.id).first();
  if (existing) return c.json({ ok: true, already: true });

  // Every file must be in R2, exactly as described, before the meal exists.
  const missing: string[] = [];
  const keyed = await Promise.all(
    meal.photos.map(async (p) => {
      const originalKey = photoKey(user.id, "original", p.id, meal.taken_at, p.mime);
      const displayKey = photoKey(user.id, "display", p.id, meal.taken_at, "image/jpeg");
      const [o, d] = await Promise.all([c.env.PHOTOS.head(originalKey), c.env.PHOTOS.head(displayKey)]);
      if (!o || o.size !== p.bytes || !o.checksums.sha256 || hex(o.checksums.sha256) !== p.sha256) missing.push(`${p.id}/original`);
      if (!d || d.size !== p.display_bytes || !d.checksums.sha256 || hex(d.checksums.sha256) !== p.display_sha256) missing.push(`${p.id}/display`);
      return { ...p, originalKey, displayKey };
    }),
  );
  if (missing.length) return c.json({ error: "files_missing", missing }, 409);

  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO meals (id, user_id, taken_at, taken_ms, tz, meal_type, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    ).bind(meal.id, user.id, meal.taken_at, Date.parse(meal.taken_at), meal.tz, meal.meal_type, meal.note, now),
    ...keyed.map((p) =>
      c.env.DB.prepare(
        `INSERT INTO photos (id, user_id, meal_id, position, original_key, original_mime, original_bytes,
           original_sha256, display_key, display_bytes, width, height, taken_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
      ).bind(p.id, user.id, meal.id, p.position, p.originalKey, p.mime, p.bytes, p.sha256, p.displayKey, p.display_bytes, p.width, p.height, p.taken_at ?? meal.taken_at),
    ),
  ]);
  return c.json({ ok: true }, 201);
});

// GET /api/meals?since=<epoch ms>&before=<epoch ms>&limit=<n> — newest first, with photo
// ids for thumbnails. `next_before` pages further back (null when there's nothing older).
meals.get("/meals", async (c) => {
  const user = c.get("user");
  const since = Number(c.req.query("since") ?? 0) || 0;
  const before = Number(c.req.query("before") ?? 0) || Number.MAX_SAFE_INTEGER;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, taken_at, tz, meal_type, note, taken_ms FROM meals
     WHERE user_id = ?1 AND deleted_at IS NULL AND taken_ms >= ?2 AND taken_ms < ?3
     ORDER BY taken_ms DESC LIMIT ?4`,
  )
    .bind(user.id, since, before, limit + 1)
    .all<Omit<Meal, "photos"> & { taken_ms: number }>();
  const page = rows.slice(0, limit);
  const next_before = rows.length > limit ? page[page.length - 1].taken_ms : null;
  const withPhotos = await attachPhotos(c.env.DB, user.id, page.map(({ taken_ms, ...m }) => m));
  const latest = await loadAnalyses(c.env.DB, user.id, withPhotos.map((m) => m.id), true);
  return c.json({ meals: withPhotos.map((m) => ({ ...m, analysis: latest.get(m.id)?.[0] ?? null })), next_before });
});

// GET /api/meals/:id — one meal, for the detail screen.
meals.get("/meals/:id{[0-9A-HJKMNP-TV-Z]{26}}", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare(
    "SELECT id, taken_at, tz, meal_type, note FROM meals WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL",
  )
    .bind(c.req.param("id"), user.id)
    .first<Omit<Meal, "photos">>();
  if (!row) return c.json({ error: "not_found" }, 404);
  const [meal] = await attachPhotos(c.env.DB, user.id, [row]);
  const all = await loadAnalyses(c.env.DB, user.id, [meal.id], false);
  return c.json({ meal: { ...meal, analyses: all.get(meal.id) ?? [] } });
});

// Analyses per meal, newest first. latestOnly keeps just the newest non-skipped one.
async function loadAnalyses(db: D1Database, userId: string, mealIds: string[], latestOnly: boolean) {
  const out = new Map<string, Analysis[]>();
  if (mealIds.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT id, meal_id, created_at, model, skipped, payload FROM analyses
       WHERE user_id = ?1 AND meal_id IN (SELECT value FROM json_each(?2)) ${latestOnly ? "AND skipped = 0" : ""}
       ORDER BY created_at DESC`,
    )
    .bind(userId, JSON.stringify(mealIds))
    .all<{ id: string; meal_id: string; created_at: string; model: string; skipped: number; payload: string }>();
  for (const r of results) {
    if (latestOnly && out.has(r.meal_id)) continue;
    const p = JSON.parse(r.payload) as Partial<Analysis>;
    const a: Analysis = {
      id: r.id,
      created_at: r.created_at,
      model: r.model,
      skipped: r.skipped === 1,
      skip_reason: p.skip_reason ?? null,
      description: p.description ?? "",
      kcal: p.kcal ?? null,
      protein_g: p.protein_g ?? null,
      carbs_g: p.carbs_g ?? null,
      fat_g: p.fat_g ?? null,
      confidence: p.confidence ?? null,
      comment: p.comment ?? null,
      foods_used: p.foods_used ?? [],
    };
    out.set(r.meal_id, [...(out.get(r.meal_id) ?? []), a]);
  }
  return out;
}

export async function attachPhotos(db: D1Database, userId: string, rows: Omit<Meal, "photos">[]): Promise<Meal[]> {
  if (rows.length === 0) return [];
  const { results: photos } = await db
    .prepare(
      `SELECT id, meal_id, position, width, height, taken_at FROM photos
       WHERE user_id = ?1 AND meal_id IN (SELECT value FROM json_each(?2))
       ORDER BY position`,
    )
    .bind(userId, JSON.stringify(rows.map((r) => r.id)))
    .all<Meal["photos"][number] & { meal_id: string }>();
  const byMeal = new Map<string, Meal["photos"]>();
  for (const { meal_id, ...p } of photos) byMeal.set(meal_id, [...(byMeal.get(meal_id) ?? []), p]);
  return rows.map((r) => ({ ...r, photos: byMeal.get(r.id) ?? [] }));
}

// DELETE /api/meals/:id — hides the meal everywhere at once. It can be restored for
// PURGE_AFTER_DAYS; after that the daily purge removes its rows and files for good.
meals.delete("/meals/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!isUlid(id)) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare("SELECT deleted_at FROM meals WHERE id = ?1 AND user_id = ?2")
    .bind(id, user.id)
    .first<{ deleted_at: string | null }>();
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!row.deleted_at) {
    await c.env.DB.prepare("UPDATE meals SET deleted_at = ?3 WHERE id = ?1 AND user_id = ?2")
      .bind(id, user.id, new Date().toISOString())
      .run();
  }
  return c.json({ ok: true });
});

// POST /api/meals/:id/restore — undoes a delete that hasn't been purged yet.
meals.post("/meals/:id/restore", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!isUlid(id)) return c.json({ error: "not_found" }, 404);
  const res = await c.env.DB.prepare("UPDATE meals SET deleted_at = NULL WHERE id = ?1 AND user_id = ?2")
    .bind(id, user.id)
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// GET /api/meals/deleted — deleted meals that can still be restored, newest first.
meals.get("/meals/deleted", async (c) => {
  const user = c.get("user");
  const { results } = await c.env.DB.prepare(
    `SELECT m.id, m.taken_at, m.meal_type, m.note, m.deleted_at,
            (SELECT p.id FROM photos p WHERE p.meal_id = m.id AND p.user_id = ?1 ORDER BY p.position LIMIT 1) AS cover_photo_id
     FROM meals m WHERE m.user_id = ?1 AND m.deleted_at IS NOT NULL
     ORDER BY m.deleted_at DESC LIMIT 200`,
  )
    .bind(user.id)
    .all<Omit<DeletedMeal, "purge_at">>();
  const purgeAt = (d: string) => new Date(Date.parse(d) + PURGE_AFTER_DAYS * 86_400_000).toISOString();
  return c.json({ meals: results.map((m) => ({ ...m, purge_at: purgeAt(m.deleted_at) })) satisfies DeletedMeal[] });
});

// GET /api/photos/:id/display — the display copy, for thumbnails and meal detail.
meals.get("/photos/:id/display", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (!isUlid(id)) return c.json({ error: "not_found" }, 404);
  const row = await c.env.DB.prepare("SELECT display_key FROM photos WHERE id = ?1 AND user_id = ?2")
    .bind(id, user.id)
    .first<{ display_key: string }>();
  const obj = row && (await c.env.PHOTOS.get(row.display_key));
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=31536000, immutable" },
  });
});

function validate(m: NewMeal | null): string | null {
  if (!m || typeof m !== "object") return "body";
  if (!isUlid(m.id)) return "id";
  if (!isIsoWithOffset(m.taken_at)) return "taken_at";
  if (typeof m.tz !== "string" || m.tz.length === 0 || m.tz.length > 64) return "tz";
  if (m.meal_type !== null && !MEAL_TYPES.includes(m.meal_type)) return "meal_type";
  if (m.note !== null && (typeof m.note !== "string" || m.note.length > MAX_NOTE)) return "note";
  if (!Array.isArray(m.photos) || m.photos.length === 0 || m.photos.length > MAX_PHOTOS) return "photos";
  const ids = new Set<string>();
  for (const p of m.photos) {
    if (!isUlid(p.id) || ids.has(p.id)) return "photo.id";
    ids.add(p.id);
    if (!Number.isInteger(p.position) || p.position < 0) return "photo.position";
    if (typeof p.mime !== "string" || !p.mime.startsWith("image/")) return "photo.mime";
    if (!Number.isInteger(p.bytes) || p.bytes <= 0 || !isSha(p.sha256)) return "photo.original";
    if (!Number.isInteger(p.display_bytes) || p.display_bytes <= 0 || !isSha(p.display_sha256)) return "photo.display";
    for (const n of [p.width, p.height]) if (n !== null && !(Number.isInteger(n) && n > 0)) return "photo.size";
    if (p.taken_at !== undefined && !isIsoWithOffset(p.taken_at)) return "photo.taken_at";
  }
  return null;
}
