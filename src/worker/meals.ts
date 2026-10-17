import { Hono } from "hono";
import type { AppEnv } from "./index";
import { isUlid } from "../shared/ulid";
import { MEAL_TYPES, photoKey, type Meal, type NewMeal } from "../shared/meals";

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
           original_sha256, display_key, display_bytes, width, height)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      ).bind(p.id, user.id, meal.id, p.position, p.originalKey, p.mime, p.bytes, p.sha256, p.displayKey, p.display_bytes, p.width, p.height),
    ),
  ]);
  return c.json({ ok: true }, 201);
});

// GET /api/meals?since=<epoch ms> — newest first, with photo ids for thumbnails.
meals.get("/meals", async (c) => {
  const user = c.get("user");
  const since = Number(c.req.query("since") ?? 0) || 0;
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, taken_at, tz, meal_type, note FROM meals
     WHERE user_id = ?1 AND deleted_at IS NULL AND taken_ms >= ?2
     ORDER BY taken_ms DESC LIMIT 200`,
  )
    .bind(user.id, since)
    .all<Omit<Meal, "photos">>();
  if (rows.length === 0) return c.json({ meals: [] });
  const { results: photos } = await c.env.DB.prepare(
    `SELECT id, meal_id, position, width, height FROM photos
     WHERE user_id = ?1 AND meal_id IN (SELECT value FROM json_each(?2))
     ORDER BY position`,
  )
    .bind(user.id, JSON.stringify(rows.map((r) => r.id)))
    .all<Meal["photos"][number] & { meal_id: string }>();
  const byMeal = new Map<string, Meal["photos"]>();
  for (const { meal_id, ...p } of photos) byMeal.set(meal_id, [...(byMeal.get(meal_id) ?? []), p]);
  return c.json({ meals: rows.map((r) => ({ ...r, photos: byMeal.get(r.id) ?? [] })) satisfies Meal[] });
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
  }
  return null;
}
