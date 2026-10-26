import { Hono } from "hono";
import type { AppEnv } from "./index";
import { isUlid, ulid } from "../shared/ulid";

// The user's side of memory (SPEC §3): notes they write, and remembered foods they can
// look at and retire. Replies maintain the foods; nothing here is required upkeep.
export const memory = new Hono<AppEnv>();
const MAX_NOTE = 2000;

memory.get("/notes", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id, body, updated_at FROM notes WHERE user_id = ?1 ORDER BY created_at")
    .bind(c.get("user").id)
    .all();
  return c.json({ notes: results });
});

memory.post("/notes", async (c) => {
  const body = (await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown })).body;
  if (typeof body !== "string" || !body.trim() || body.length > MAX_NOTE) return c.json({ error: "bad_request" }, 400);
  const now = new Date().toISOString();
  const id = ulid();
  await c.env.DB.prepare("INSERT INTO notes (id, user_id, body, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)")
    .bind(id, c.get("user").id, body.trim(), now)
    .run();
  return c.json({ id }, 201);
});

memory.put("/notes/:id", async (c) => {
  const body = (await c.req.json<{ body?: unknown }>().catch(() => ({}) as { body?: unknown })).body;
  if (!isUlid(c.req.param("id")) || typeof body !== "string" || !body.trim() || body.length > MAX_NOTE) {
    return c.json({ error: "bad_request" }, 400);
  }
  const res = await c.env.DB.prepare("UPDATE notes SET body = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2")
    .bind(c.req.param("id"), c.get("user").id, body.trim(), new Date().toISOString())
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

memory.delete("/notes/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM notes WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.get("user").id).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// Each food with how often it's been used: meals whose newest estimate lists its code, and
// the latest such meal. Derived at read time, so it's never stale and needs no backfill.
// It's what a later cleanup of rarely used foods will be judged on (SPEC §11).
memory.get("/foods", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.code, f.name, f.serving, f.kcal, f.protein_g, f.carbs_g, f.fat_g, f.fiber_g, f.status, f.created_at, f.updated_at,
       COALESCE(u.uses, 0) AS uses, u.last_used
     FROM foods f
     LEFT JOIN (
       SELECT j.value AS code, COUNT(*) AS uses, MAX(m.taken_at) AS last_used
       FROM meals m
       JOIN analyses a ON a.id = (SELECT id FROM analyses x WHERE x.user_id = ?1 AND x.meal_id = m.id AND x.skipped = 0
                                  ORDER BY x.created_at DESC LIMIT 1),
         json_each(json_extract(a.payload, '$.foods_used')) j
       WHERE m.user_id = ?1 AND m.deleted_at IS NULL
       GROUP BY j.value
     ) u ON u.code = f.code
     WHERE f.user_id = ?1 ORDER BY f.status, CAST(substr(f.code, 2) AS INTEGER)`,
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ foods: results });
});

// Retire (or bring back) a remembered food: retired foods stay out of prompts.
memory.post("/foods/:code/:to{retire|restore}", async (c) => {
  const retire = c.req.param("to") === "retire";
  const now = new Date().toISOString();
  const res = await c.env.DB.prepare(
    "UPDATE foods SET status = ?3, retired_at = ?4, updated_at = ?5 WHERE user_id = ?1 AND code = ?2",
  )
    .bind(c.get("user").id, c.req.param("code"), retire ? "retired" : "active", retire ? now : null, now)
    .run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// Questions a model asked before replying (prompt/4). Every prompt lists them so they aren't
// asked again; deleting one lets it be asked again.
memory.get("/questions", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, topic, question, answer, created_at FROM questions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 200",
  )
    .bind(c.get("user").id)
    .all();
  return c.json({ questions: results });
});

memory.delete("/questions/:id", async (c) => {
  const res = await c.env.DB.prepare("DELETE FROM questions WHERE id = ?1 AND user_id = ?2").bind(c.req.param("id"), c.get("user").id).run();
  return res.meta.changes ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});
