import { Hono } from "hono";
import type { AppEnv } from "./index";
import { attachPhotos } from "./meals";
import { buildBatch, importReply, type RunUsage } from "./batches";
import { batchKey, photoFileName } from "../shared/prompt";
import { REPLY_JSON_SCHEMA } from "../shared/reply";
import { isUlid, ulid } from "../shared/ulid";
import { whisper } from "./transcribe";
import { checkImageLink, imageLink } from "./imagelink";
import { send as sendPush } from "./push";
import { wake } from "./clock";
import type { ApiState, Meal } from "../shared/meals";

// The API path (D27, D28): each new meal is analyzed automatically through OpenRouter,
// with the same batch, prompt (its API variant) and validator as the chat handoff. Each
// user's Durable Object alarm runs their queue when a run is due (D31); nothing waits on
// the phone.
// Only what any vision model offers is used (text and images in, JSON out, a cost per
// call), so switching models is a setting, not a code change.

type ApiEnv = Env & { OPENROUTER_API_KEY?: string; OPENROUTER_STUB?: string; SESSION_SECRET?: string; AUTH_DISABLED?: string };

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_ATTEMPTS = 3;
const JOBS_PER_RUN = 3; // per cron invocation; each run is one model call
const STALE_RUNNING_MS = 10 * 60_000; // a run this old was cut off: try again

// Suggested in the app; any OpenRouter id with image input works.
export const SUGGESTED_MODELS = ["anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"];

// GET /img/:photo/:exp/:sig.jpg — a display copy, for the model provider. No session: the
// signature is the permission, and it expires.
export const images = new Hono<AppEnv>();
images.get("/:photo/:exp/:sig", async (c) => {
  const photo = c.req.param("photo");
  if (!(await checkImageLink(c.env, photo, c.req.param("exp"), c.req.param("sig")))) return c.json({ error: "forbidden" }, 403);
  const row = await c.env.DB.prepare("SELECT display_key FROM photos WHERE id = ?1").bind(photo).first<{ display_key: string }>();
  const obj = row && (await c.env.PHOTOS.get(row.display_key));
  if (!obj) return c.json({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" } });
});

// ── One model call ──────────────────────────────────────────────────────────

type Images = { name: string; url: string }[];

// Everything sent besides the messages. Stored on the batch as it was sent (D33), so the
// corpus records how each run was made, not just what it was shown.
function requestSettings(model: string) {
  return {
    model,
    // Held to the reply schema where the model supports it; validated either way.
    response_format: { type: "json_schema", json_schema: { name: "bitebook_reply", strict: true, schema: REPLY_JSON_SCHEMA } },
    reasoning: { effort: "medium" },
    usage: { include: true },
    max_tokens: 16_000,
  };
}

// The stored form: the schema by name and version rather than in full (the code holds it),
// plus how the photos were sent.
const recordedSettings = (model: string, images: Images) => {
  const { response_format, ...rest } = requestSettings(model);
  return {
    provider: "openrouter",
    ...rest,
    response_format: { type: response_format.type, schema: "bitebook.reply/1", name: response_format.json_schema.name, strict: true },
    images: { count: images.length, via: "signed_url", copy: "display (1600 px JPEG, quality 0.8)", labelled: "file name before each" },
  };
};
type CallResult = { text: string; model: string; usage: RunUsage };

async function callModel(env: ApiEnv, model: string, prompt: string, images: Images, stubFacts: StubFacts): Promise<CallResult> {
  const started = Date.now();
  if (env.OPENROUTER_STUB === "1") return { text: stubReply(stubFacts), model: `${model} (stub)`, usage: { input_tokens: 1000, output_tokens: 200, cost_usd: 0.01, latency_ms: 5 } };
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set");
  const content = [
    { type: "text", text: prompt },
    // Each photo is preceded by its file name, which the prompt refers to.
    ...images.flatMap((im) => [
      { type: "text", text: im.name },
      { type: "image_url", image_url: { url: im.url } },
    ]),
  ];
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bitebook.mishabhi.workers.dev",
      "X-Title": "Bitebook",
    },
    body: JSON.stringify({ ...requestSettings(model), messages: [{ role: "user", content }] }),
  });
  const body = (await res.json().catch(() => null)) as {
    model?: string;
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    error?: { message?: string; code?: number };
  } | null;
  if (!res.ok || !body?.choices?.[0]?.message?.content) {
    throw new Error(`openrouter ${res.status}: ${body?.error?.message ?? "no reply text"}`.slice(0, 300));
  }
  return {
    text: body.choices[0].message.content,
    model: body.model ?? model,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? null,
      output_tokens: body.usage?.completion_tokens ?? null,
      cost_usd: body.usage?.cost ?? null,
      latency_ms: Date.now() - started,
    },
  };
}

// End-to-end tests can't call a model: a valid reply built from the batch's facts. A note
// containing "ASK" makes it ask a question; a revision echoes what the user said.
type StubFacts = { batchId: string; keys: string[]; note: string | null; revisionInput: string | null };
function stubReply(f: StubFacts): string {
  return JSON.stringify({
    schema: "bitebook.reply/1",
    batch_id: f.batchId,
    model: "stub",
    meals: f.keys.map((key) => ({
      key, skipped: false, skip_reason: null,
      description: f.revisionInput ? `revised: ${f.revisionInput.replace(/\s+/g, " ").slice(0, 80)}` : "stub estimate",
      kcal: f.revisionInput ? 650 : 500, protein_g: 20, carbs_g: 60, fat_g: 15, fiber_g: 6,
      confidence: "medium", foods_used: [], comment: null,
    })),
    remember: [],
    questions: !f.revisionInput && f.note?.includes("ASK") ? [{ topic: "portion", question: "Was that a full plate or half?" }] : [],
    summary: { text: "Stub summary.", suggestion: null },
  });
}

// ── The queue ───────────────────────────────────────────────────────────────

type Job = { id: string; user_id: string; meal_id: string; kind: "analyze" | "revise"; input: string | null; model: string; attempts: number };

// Queues a run and wakes the user's clock for it (D31): nothing polls the queue.
export async function enqueue(env: ApiEnv, userId: string, mealId: string, model: string, kind: Job["kind"], input: string | null, delayMs = 0) {
  const now = Date.now();
  await env.DB
    .prepare(
      `INSERT INTO analysis_jobs (id, user_id, meal_id, kind, input, model, run_after_ms, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    )
    .bind(ulid(), userId, mealId, kind, input, model, now + delayMs, new Date(now).toISOString())
    .run();
  await wake(env, userId);
}

// When the user's clock should next wake for the queue: the earliest queued run, or a
// running one that's gone quiet (its Worker was cut off) and should be taken back.
export async function nextJob(env: ApiEnv, userId: string): Promise<number | null> {
  const r = await env.DB.prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT run_after_ms AS t FROM analysis_jobs WHERE user_id = ?1 AND status = 'queued'
       UNION ALL
       SELECT CAST(strftime('%s', updated_at) AS INTEGER) * 1000 + ?2 FROM analysis_jobs WHERE user_id = ?1 AND status = 'running')`,
  )
    .bind(userId, STALE_RUNNING_MS)
    .first<{ t: number | null }>();
  return r?.t ?? null;
}

// From the user's clock (src/worker/clock.ts). Claims a few due runs (a conditional
// update, so a retried alarm can't take the same one twice) and runs them in turn.
export async function runDueJobs(env: ApiEnv, origin: string, userId: string, now = Date.now()) {
  await env.DB.prepare("UPDATE analysis_jobs SET status = 'queued', updated_at = ?3 WHERE user_id = ?1 AND status = 'running' AND updated_at < ?2")
    .bind(userId, new Date(now - STALE_RUNNING_MS).toISOString(), new Date(now).toISOString())
    .run();
  const { results } = await env.DB.prepare(
    "SELECT id, user_id, meal_id, kind, input, model, attempts FROM analysis_jobs WHERE user_id = ?1 AND status = 'queued' AND run_after_ms <= ?2 ORDER BY run_after_ms LIMIT ?3",
  )
    .bind(userId, now, JOBS_PER_RUN)
    .all<Job>();
  for (const job of results) {
    const claimed = await env.DB.prepare(
      "UPDATE analysis_jobs SET status = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status = 'queued'",
    )
      .bind(job.id, new Date().toISOString())
      .run();
    if (!claimed.meta.changes) continue;
    try {
      const batchId = await runJob(env, origin, job);
      await env.DB.prepare("UPDATE analysis_jobs SET status = 'done', batch_id = ?2, error = NULL, updated_at = ?3 WHERE id = ?1")
        .bind(job.id, batchId, new Date().toISOString())
        .run();
    } catch (e) {
      const error = String((e as Error).message ?? e).slice(0, 500);
      const attempts = job.attempts + 1;
      const retry = attempts < MAX_ATTEMPTS;
      console.error(`analysis job ${job.id} (${job.kind} ${job.meal_id}) attempt ${attempts}: ${error}`);
      await env.DB.prepare("UPDATE analysis_jobs SET status = ?2, error = ?3, run_after_ms = ?4, updated_at = ?5 WHERE id = ?1")
        .bind(job.id, retry ? "queued" : "failed", error, Date.now() + 2 ** attempts * 60_000, new Date().toISOString())
        .run();
    }
  }
}

async function runJob(env: ApiEnv, origin: string, job: Job): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id, taken_at, tz, meal_type, note FROM meals WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL")
    .bind(job.meal_id, job.user_id)
    .first<Omit<Meal, "photos">>();
  if (!row) return null; // deleted meanwhile: nothing to do
  if (job.kind === "analyze") {
    const done = await env.DB.prepare("SELECT 1 FROM analyses WHERE user_id = ?1 AND meal_id = ?2 AND skipped = 0").bind(job.user_id, job.meal_id).first();
    if (done) return null; // analyzed some other way since (e.g. through the chat)
  }
  const [meal] = await attachPhotos(env.DB, job.user_id, [row]);

  let revision: { key: string; previous: unknown; input: string } | undefined;
  if (job.kind === "revise") {
    const prev = await env.DB.prepare(
      "SELECT payload FROM analyses WHERE user_id = ?1 AND meal_id = ?2 AND skipped = 0 ORDER BY created_at DESC LIMIT 1",
    )
      .bind(job.user_id, job.meal_id)
      .first<{ payload: string }>();
    const { key: _key, ...previous } = prev ? (JSON.parse(prev.payload) as Record<string, unknown>) : {};
    revision = { key: batchKey(0), previous, input: job.input ?? "" };
  }

  const batchId = await buildBatch(env, job.user_id, [meal], { channel: "api", revision });
  await env.DB.prepare("UPDATE analysis_jobs SET batch_id = ?2 WHERE id = ?1").bind(job.id, batchId).run();
  const prompt = (await env.DB.prepare("SELECT prompt_text FROM batches WHERE id = ?1").bind(batchId).first<{ prompt_text: string }>())!.prompt_text;
  const images: Images = await Promise.all(
    meal.photos.map(async (p) => ({ name: photoFileName(batchKey(0), p.position, p.taken_at ?? meal.taken_at), url: await imageLink(env, origin, p.id) })),
  );

  await env.DB.prepare("UPDATE batches SET request_params = ?2 WHERE id = ?1")
    .bind(batchId, JSON.stringify(recordedSettings(job.model, images)))
    .run();
  let call: CallResult;
  try {
    call = await callModel(env, job.model, prompt, images, { batchId, keys: [batchKey(0)], note: meal.note, revisionInput: revision?.input ?? null });
  } catch (e) {
    await env.DB.prepare("UPDATE batches SET status = 'abandoned' WHERE id = ?1").bind(batchId).run();
    throw e;
  }
  const result = await importReply(env.DB, job.user_id, batchId, call.text, call.model, call.usage);
  if (result.status !== 200) {
    // Keep what came back, for debugging, and what it cost: a failed run still costs.
    await env.DB.prepare("UPDATE batches SET status = 'abandoned', reply_raw = ?2, cost_usd = ?3, input_tokens = ?4, output_tokens = ?5 WHERE id = ?1")
      .bind(batchId, call.text, call.usage.cost_usd, call.usage.input_tokens, call.usage.output_tokens)
      .run();
    throw new Error(`invalid reply: ${JSON.stringify(result.body.errors ?? result.body).slice(0, 300)}`);
  }
  // A question is only useful while the meal is fresh in mind: say so on the phone (D30).
  const questions = (result.body.questions as { question: string }[] | undefined) ?? [];
  if (questions.length) {
    const what = `${meal.meal_type ?? "meal"} at ${meal.taken_at.slice(11, 16)}`;
    await sendPush(env, job.user_id, {
      title: questions.length === 1 ? "A question about your " + what : `${questions.length} questions about your ${what}`,
      body: questions[0].question,
      navigate: `/#/meal/${meal.id}`,
      tag: `question-${meal.id}`,
    }).catch((e) => console.error("question push:", e));
  }
  return batchId;
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const analysis = new Hono<AppEnv>();

// Meals with no analysis that nothing is working on: saved while automatic analysis was
// off, or whose run failed for good.
const WAITING_SQL = `SELECT m.id FROM meals m WHERE m.user_id = ?1 AND m.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.user_id = ?1 AND a.meal_id = m.id AND a.skipped = 0)
    AND NOT EXISTS (SELECT 1 FROM batches b, json_each(b.key_map) k WHERE b.user_id = ?1 AND b.status = 'open' AND k.value = m.id)
    AND NOT EXISTS (SELECT 1 FROM analysis_jobs j WHERE j.user_id = ?1 AND j.meal_id = m.id AND j.status IN ('queued','running'))`;

// GET /api/analysis/settings — the model meals are analyzed with (null: off), suggestions,
// and how many meals are waiting for it.
analysis.get("/analysis/settings", async (c) => {
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT api_model FROM users WHERE id = ?1").bind(user.id).first<{ api_model: string | null }>();
  const waiting = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM (${WAITING_SQL})`).bind(user.id).first<{ n: number }>();
  return c.json({
    model: row?.api_model ?? null,
    suggested: SUGGESTED_MODELS,
    configured: Boolean((c.env as ApiEnv).OPENROUTER_API_KEY || (c.env as ApiEnv).OPENROUTER_STUB),
    waiting: waiting?.n ?? 0,
  });
});

// PUT /api/analysis/settings {model} — an OpenRouter model id, or null to turn it off.
analysis.put("/analysis/settings", async (c) => {
  const body = await c.req.json<{ model?: unknown }>().catch(() => ({}) as { model?: unknown });
  const model = typeof body.model === "string" ? body.model.trim() : null;
  if (model !== null && !/^[\w.-]+\/[\w.:-]+$/.test(model)) return c.json({ error: "bad_model" }, 400);
  await c.env.DB.prepare("UPDATE users SET api_model = ?2 WHERE id = ?1").bind(c.get("user").id, model || null).run();
  return c.json({ ok: true, model: model || null });
});

// POST /api/analysis/queue-pending {meal_ids?} — analyze the waiting meals now: all of them,
// or the ones picked on Analyze.
analysis.post("/analysis/queue-pending", async (c) => {
  const user = c.get("user");
  const model = await userModel(c.env.DB, user.id);
  if (!model) return c.json({ error: "off" }, 409);
  const body = await c.req.json<{ meal_ids?: unknown }>().catch(() => ({}) as { meal_ids?: unknown });
  const picked = Array.isArray(body.meal_ids) ? body.meal_ids.filter(isUlid) : null;
  const { results } = await c.env.DB.prepare(
    `${WAITING_SQL} ${picked ? "AND m.id IN (SELECT value FROM json_each(?2))" : "AND ?2 IS NULL"} ORDER BY m.taken_ms LIMIT 50`,
  )
    .bind(user.id, picked ? JSON.stringify(picked) : null)
    .all<{ id: string }>();
  for (const m of results) await enqueue(c.env, user.id, m.id, model, "analyze", null);
  return c.json({ ok: true, queued: results.length });
});

// POST /api/meals/:id/answers {answers: [{id, answer}]} — answers to the model's questions;
// the meal is re-estimated with them. Each answered question joins "already asked".
analysis.post("/meals/:id{[0-9A-HJKMNP-TV-Z]{26}}/answers", async (c) => {
  const user = c.get("user");
  const mealId = c.req.param("id");
  const model = await userModel(c.env.DB, user.id);
  if (!model) return c.json({ error: "off" }, 409);
  const body = await c.req.json<{ answers?: unknown }>().catch(() => ({}) as { answers?: unknown });
  const answers = (Array.isArray(body.answers) ? body.answers : []).filter(
    (a): a is { id: string; answer: string } => typeof a?.id === "string" && typeof a?.answer === "string" && a.answer.trim().length > 0 && a.answer.length <= 2000,
  );
  if (answers.length === 0) return c.json({ error: "bad_request" }, 400);
  const { results: open } = await c.env.DB.prepare(
    "SELECT id, question FROM questions WHERE user_id = ?1 AND meal_id = ?2 AND answer IS NULL",
  )
    .bind(user.id, mealId)
    .all<{ id: string; question: string }>();
  const now = new Date().toISOString();
  const lines: string[] = [];
  for (const a of answers) {
    const q = open.find((x) => x.id === a.id);
    if (!q) continue;
    await c.env.DB.prepare("UPDATE questions SET answer = ?3, answered_at = ?4 WHERE id = ?1 AND user_id = ?2").bind(q.id, user.id, a.answer.trim(), now).run();
    lines.push(`You asked: ${q.question}\nMy answer: ${a.answer.trim()}`);
  }
  if (lines.length === 0) return c.json({ error: "not_found" }, 404);
  await enqueue(c.env, user.id, mealId, model, "revise", lines.join("\n"));
  return c.json({ ok: true });
});

// POST /api/meals/:id/correct {text} — "that's wrong": the meal is re-estimated with it.
analysis.post("/meals/:id{[0-9A-HJKMNP-TV-Z]{26}}/correct", async (c) => {
  const user = c.get("user");
  const model = await userModel(c.env.DB, user.id);
  if (!model) return c.json({ error: "off" }, 409);
  const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > 2000) return c.json({ error: "bad_request" }, 400);
  const meal = await c.env.DB.prepare("SELECT 1 FROM meals WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL").bind(c.req.param("id"), user.id).first();
  if (!meal) return c.json({ error: "not_found" }, 404);
  await enqueue(c.env, user.id, c.req.param("id"), model, "revise", `My correction: ${text}`);
  return c.json({ ok: true });
});

// POST /api/meals/:id/retry — runs a failed analysis or revision again.
analysis.post("/meals/:id{[0-9A-HJKMNP-TV-Z]{26}}/retry", async (c) => {
  const user = c.get("user");
  const model = await userModel(c.env.DB, user.id);
  if (!model) return c.json({ error: "off" }, 409);
  const last = await c.env.DB.prepare(
    "SELECT kind, input, status FROM analysis_jobs WHERE user_id = ?1 AND meal_id = ?2 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(user.id, c.req.param("id"))
    .first<{ kind: Job["kind"]; input: string | null; status: string }>();
  if (!last || last.status !== "failed") return c.json({ error: "nothing_to_retry" }, 409);
  await enqueue(c.env, user.id, c.req.param("id"), model, last.kind, last.input);
  return c.json({ ok: true });
});

// GET /api/analysis/usage — what the API path has cost, per local day (UTC dates for now).
analysis.get("/analysis/usage", async (c) => {
  const user = c.get("user");
  const { results: days } = await c.env.DB.prepare(
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS runs, SUM(cost_usd) AS cost_usd,
       SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, AVG(latency_ms) AS avg_latency_ms
     FROM batches WHERE user_id = ?1 AND channel = 'api' AND cost_usd IS NOT NULL AND created_at >= ?2
     GROUP BY day ORDER BY day DESC`,
  )
    .bind(user.id, new Date(Date.now() - 30 * 86_400_000).toISOString())
    .all<{ day: string; runs: number; cost_usd: number; input_tokens: number; output_tokens: number; avg_latency_ms: number }>();
  const meals = await c.env.DB.prepare(
    `SELECT COUNT(DISTINCT a.meal_id) AS n FROM analyses a JOIN batches b ON b.id = a.batch_id
     WHERE a.user_id = ?1 AND b.channel = 'api' AND b.created_at >= ?2`,
  )
    .bind(user.id, new Date(Date.now() - 30 * 86_400_000).toISOString())
    .first<{ n: number }>();
  return c.json({ days, meals_30d: meals?.n ?? 0 });
});

// POST /api/analysis/transcribe — a spoken answer or correction (audio body, up to a
// minute), as text for the user to send. The audio is kept beside the meal voice notes.
analysis.post("/analysis/transcribe", async (c) => {
  const user = c.get("user");
  const mime = (c.req.header("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!mime.startsWith("audio/")) return c.json({ error: "bad_type" }, 415);
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.length === 0 || audio.length > 5 * 1024 * 1024) return c.json({ error: "bad_size" }, 413);
  const id = ulid();
  const ext = mime.includes("mp4") || mime.includes("m4a") ? "m4a" : mime.includes("webm") ? "webm" : "audio";
  await c.env.PHOTOS.put(`users/${user.id}/voice/replies/${id}.${ext}`, audio, { httpMetadata: { contentType: mime } });
  try {
    return c.json({ text: (await whisper(c.env, user.id, audio)).text });
  } catch (e) {
    console.error("transcribe reply:", e);
    return c.json({ error: "transcribe_failed" }, 502);
  }
});

async function userModel(db: D1Database, userId: string) {
  return (await db.prepare("SELECT api_model FROM users WHERE id = ?1").bind(userId).first<{ api_model: string | null }>())?.api_model ?? null;
}

// What the meal screens show about the API path: the latest run and open questions.
export async function analysisState(db: D1Database, userId: string, mealIds: string[]) {
  const out = new Map<string, ApiState>();
  if (mealIds.length === 0) return out;
  const ids = JSON.stringify(mealIds);
  const { results: jobs } = await db
    .prepare(
      `SELECT meal_id, status, kind, error FROM analysis_jobs j WHERE user_id = ?1 AND meal_id IN (SELECT value FROM json_each(?2))
         AND id = (SELECT id FROM analysis_jobs k WHERE k.user_id = ?1 AND k.meal_id = j.meal_id ORDER BY created_at DESC LIMIT 1)`,
    )
    .bind(userId, ids)
    .all<{ meal_id: string } & NonNullable<ApiState["job"]>>();
  const { results: qs } = await db
    .prepare("SELECT id, meal_id, topic, question FROM questions WHERE user_id = ?1 AND answer IS NULL AND meal_id IN (SELECT value FROM json_each(?2)) ORDER BY created_at")
    .bind(userId, ids)
    .all<{ id: string; meal_id: string; topic: string; question: string }>();
  for (const id of mealIds) {
    const j = jobs.find((x) => x.meal_id === id);
    out.set(id, { job: j ? { status: j.status, kind: j.kind, error: j.error } : null, questions: qs.filter((q) => q.meal_id === id).map(({ meal_id: _m, ...q }) => q) });
  }
  return out;
}
