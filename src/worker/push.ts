import { Hono } from "hono";
import { createPusher } from "webpush-edge";
import type { AppEnv } from "./index";
import { dueReminders, localClock, morningMessage, nightlyMessage, type ReminderUser } from "../shared/reminders";

// Reminders by Web Push (D25), with webpush-edge doing the encryption and signing (the
// pwa-cloudflare skill's choice; Apple accepts only aes128gcm). Subscriptions live in D1.
export const push = new Hono<AppEnv>();

type PushEnv = Env & { VAPID_PRIVATE_JWK?: string; PUSH_STUB?: string };
type Notification = { title: string; body: string; navigate: string; tag: string };
type SendResult = { sent: number; failed: number; pruned: number; statuses: number[] };

const isTz = (tz: unknown): tz is string => {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

// The store webpush-edge prunes through (404/410 from the push service: device gone).
function d1Store(db: D1Database) {
  return {
    async get(userId: string) {
      const { results } = await db
        .prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1")
        .bind(userId)
        .all<{ endpoint: string; p256dh: string; auth: string }>();
      return results.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
    },
    // Called with the whole list after pruning: delete what's gone, never touch the rest
    // (their created_at and tz stay as they were).
    async set(userId: string, subs: { endpoint: string }[]) {
      await db
        .prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint NOT IN (SELECT value FROM json_each(?2))")
        .bind(userId, JSON.stringify(subs.map((s) => s.endpoint)))
        .run();
    },
  };
}

export async function send(env: PushEnv, userId: string, n: Notification): Promise<SendResult> {
  if (env.PUSH_STUB === "1") {
    // Tests can't reach a push service: count the devices as if it had worked.
    const devices = await d1Store(env.DB).get(userId);
    return { sent: devices.length, failed: 0, pruned: 0, statuses: devices.map(() => 201) };
  }
  if (!env.VAPID_PRIVATE_JWK) throw new Error("VAPID_PRIVATE_JWK is not set");
  const pusher = createPusher({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    contact: "mailto:" + env.ALLOWED_EMAILS.split(",")[0].trim(),
    store: d1Store(env.DB),
  });
  // A reminder is stale after a few hours; don't let the push service deliver it at noon.
  const r = await pusher.send(userId, n, { ttl: 4 * 3600, urgency: "normal" });
  return { sent: r.sent, failed: r.failed, pruned: r.pruned, statuses: r.results.map((x: { status: number }) => x.status) };
}

// GET /api/push/key — the VAPID public key the browser subscribes with.
push.get("/push/key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

// POST /api/push/subscribe {subscription} — X-Timezone: the device's zone. Idempotent per
// endpoint; the page re-sends it on every open, which also keeps the zone current. The
// service worker re-subscribes without a zone when the endpoint rotates: keep the old one.
push.post("/push/subscribe", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>().catch(() => null);
  const s = body?.subscription;
  const endpoint = s?.endpoint;
  const { p256dh, auth } = s?.keys ?? {};
  if (typeof endpoint !== "string" || !endpoint.startsWith("https://") || endpoint.length > 1000) return c.json({ ok: false, error: "bad_subscription" }, 400);
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 200 || auth.length > 100) return c.json({ ok: false, error: "bad_subscription" }, 400);
  const tz = c.req.header("X-Timezone");
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, tz, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = ?2, p256dh = ?3, auth = ?4, tz = COALESCE(?5, tz), updated_at = ?6`,
  )
    .bind(endpoint, user.id, p256dh, auth, isTz(tz) ? tz : null, now)
    .run();
  const devices = (await d1Store(c.env.DB).get(user.id)).length;
  return c.json({ ok: true, devices });
});

// POST /api/push/unsubscribe {endpoint}
push.post("/push/unsubscribe", async (c) => {
  const user = c.get("user");
  const body = await c.req.json<{ endpoint?: unknown }>().catch(() => null);
  if (typeof body?.endpoint === "string") {
    await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?1 AND endpoint = ?2").bind(user.id, body.endpoint).run();
  }
  return c.json({ ok: true, devices: (await d1Store(c.env.DB).get(user.id)).length });
});

// GET /api/push/status — how many devices get reminders, for the Memory screen.
push.get("/push/status", async (c) => c.json({ devices: (await d1Store(c.env.DB).get(c.get("user").id)).length }));

// POST /api/push/test — sends one now. The statuses turn "nothing arrived" into a reason:
// 201 accepted, 403 VAPID key mismatch, 400 encryption, 410 subscription gone.
push.post("/push/test", async (c) => {
  const r = await send(c.env, c.get("user").id, {
    title: "Bitebook",
    body: "Reminders are on. Tap to open your timeline.",
    navigate: "/#/timeline",
    tag: "test",
  });
  return c.json(r);
});

// From the cron trigger, every 15 minutes: send whatever reminders are due now.
export async function runReminders(env: PushEnv, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT s.user_id,
       (SELECT tz FROM push_subscriptions t WHERE t.user_id = s.user_id AND t.tz IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS tz,
       (SELECT MAX(taken_ms) FROM meals m WHERE m.user_id = s.user_id AND m.deleted_at IS NULL) AS last_meal_ms,
       (SELECT MAX(sent_ms) FROM reminders_sent r WHERE r.user_id = s.user_id AND r.kind = 'morning') AS last_morning_ms
     FROM push_subscriptions s GROUP BY s.user_id`,
  ).all<{ user_id: string; tz: string | null; last_meal_ms: number | null; last_morning_ms: number | null }>();

  const users: ReminderUser[] = [];
  for (const r of results) {
    if (!r.tz) continue; // no zone yet: can't tell when 10:30 pm is
    const today = localClock(r.tz, now).date;
    const { results: sent } = await env.DB.prepare("SELECT kind FROM reminders_sent WHERE user_id = ?1 AND local_date = ?2")
      .bind(r.user_id, today)
      .all<{ kind: string }>();
    users.push({
      userId: r.user_id,
      tz: r.tz,
      lastMealMs: r.last_meal_ms,
      lastMorningMs: r.last_morning_ms,
      sentToday: { nightly: sent.some((s) => s.kind === "nightly"), morning: sent.some((s) => s.kind === "morning") },
    });
  }

  for (const due of dueReminders(users, now)) {
    const u = users.find((x) => x.userId === due.userId)!;
    // Claim the slot first, so overlapping runs can't both send.
    const claimed = await env.DB.prepare(
      "INSERT OR IGNORE INTO reminders_sent (user_id, kind, local_date, sent_ms, result) VALUES (?1, ?2, ?3, ?4, '{}')",
    )
      .bind(due.userId, due.kind, due.localDate, now)
      .run();
    if (!claimed.meta.changes) continue;
    let n: Notification;
    if (due.kind === "nightly") {
      const { results: meals } = await env.DB.prepare(
        "SELECT taken_ms FROM meals WHERE user_id = ?1 AND deleted_at IS NULL AND taken_ms > ?2",
      )
        .bind(due.userId, now - 36 * 3_600_000)
        .all<{ taken_ms: number }>();
      n = nightlyMessage(meals.filter((m) => localClock(u.tz, m.taken_ms).date === due.localDate).length);
    } else {
      n = morningMessage(u.lastMealMs!, u.tz);
    }
    let result: SendResult | { error: string };
    try {
      result = await send(env, due.userId, n);
    } catch (e) {
      result = { error: String((e as Error).message ?? e) };
    }
    console.log(`reminder ${due.kind} for ${due.userId}: ${JSON.stringify(result)}`);
    await env.DB.prepare("UPDATE reminders_sent SET result = ?4 WHERE user_id = ?1 AND kind = ?2 AND local_date = ?3")
      .bind(due.userId, due.kind, due.localDate, JSON.stringify(result))
      .run();
  }
}
