import { Hono } from "hono";
import type { AppEnv } from "./index";

// GET /api/overview?days=30 — what Today and Trends show (D30): totals per local day from
// each meal's newest estimate, the model's questions waiting for an answer, its latest
// comment, and whether the chat handoff has work to do.
export const overview = new Hono<AppEnv>();

export type DayTotals = {
  date: string; // YYYY-MM-DD, the meal's own local date
  meals: number;
  analyzed: number;
  analyzing: number;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  fiber_g: number;
  fiber_meals: number; // analyzed meals with a fiber estimate (prompt/7 on)
};

overview.get("/overview", async (c) => {
  const user = c.get("user");
  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 1), 92);
  // A day of slack, since a meal's local date can be "tomorrow" in UTC terms and back.
  const since = Date.now() - (days + 1) * 86_400_000;
  const { results: rows } = await c.env.DB.prepare(
    `SELECT substr(m.taken_at, 1, 10) AS date, a.payload,
       EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.user_id = ?1 AND j.meal_id = m.id AND j.status IN ('queued','running')) AS busy
     FROM meals m
     LEFT JOIN analyses a ON a.id = (SELECT id FROM analyses x WHERE x.user_id = ?1 AND x.meal_id = m.id AND x.skipped = 0
                                     ORDER BY x.created_at DESC LIMIT 1)
     WHERE m.user_id = ?1 AND m.deleted_at IS NULL AND m.taken_ms >= ?2`,
  )
    .bind(user.id, since)
    .all<{ date: string; payload: string | null; busy: number }>();

  const byDate = new Map<string, DayTotals>();
  for (const r of rows) {
    const d = byDate.get(r.date) ?? { date: r.date, meals: 0, analyzed: 0, analyzing: 0, kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, fiber_meals: 0 };
    d.meals++;
    if (r.payload) {
      const p = JSON.parse(r.payload) as Record<string, unknown>;
      const n = (k: string) => (typeof p[k] === "number" ? (p[k] as number) : 0);
      d.analyzed++;
      d.kcal += n("kcal");
      d.protein_g += n("protein_g");
      d.carbs_g += n("carbs_g");
      d.fat_g += n("fat_g");
      if (typeof p.fiber_g === "number") {
        d.fiber_g += p.fiber_g;
        d.fiber_meals++;
      }
    } else if (r.busy) d.analyzing++;
    byDate.set(r.date, d);
  }

  const [questions, latest, settings, chatWaiting] = await Promise.all([
    c.env.DB.prepare(
      `SELECT q.id, q.question, m.id AS meal_id, m.taken_at, m.meal_type FROM questions q JOIN meals m ON m.id = q.meal_id
       WHERE q.user_id = ?1 AND q.answer IS NULL AND m.deleted_at IS NULL ORDER BY q.created_at DESC LIMIT 10`,
    )
      .bind(user.id)
      .all<{ id: string; question: string; meal_id: string; taken_at: string; meal_type: string | null }>(),
    c.env.DB.prepare(
      "SELECT summary, reply_model, imported_at, channel FROM batches WHERE user_id = ?1 AND status = 'imported' AND summary IS NOT NULL ORDER BY imported_at DESC LIMIT 1",
    )
      .bind(user.id)
      .first<{ summary: string; reply_model: string; imported_at: string; channel: string }>(),
    c.env.DB.prepare("SELECT api_model FROM users WHERE id = ?1").bind(user.id).first<{ api_model: string | null }>(),
    // Same rule as the Analyze screen's list: not analyzed, not in an open batch, not queued.
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM meals m WHERE m.user_id = ?1 AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.user_id = ?1 AND a.meal_id = m.id AND a.skipped = 0)
         AND NOT EXISTS (SELECT 1 FROM batches b, json_each(b.key_map) k WHERE b.user_id = ?1 AND b.status = 'open' AND k.value = m.id)
         AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.user_id = ?1 AND j.meal_id = m.id AND j.status IN ('queued','running'))`,
    )
      .bind(user.id)
      .first<{ n: number }>(),
  ]);

  return c.json({
    days: [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)),
    questions: questions.results,
    latest: latest ? { ...(JSON.parse(latest.summary) as { text: string; suggestion: string | null }), model: latest.reply_model, at: latest.imported_at } : null,
    auto_model: settings?.api_model ?? null,
    chat_waiting: chatWaiting?.n ?? 0,
  });
});
