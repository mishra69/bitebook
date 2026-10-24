import { expect, test } from "@playwright/test";
import { openApp, sql } from "./helpers";

// The e2e server can't reach a push service (PUSH_STUB): this checks everything up to it.
const subscription = (n: number) => ({
  endpoint: `https://push.example.test/device-${n}`,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
});

test("a device registers for reminders with its zone, and a test reminder reaches it", async ({ page, request }) => {
  const sub = (n: number, tz?: string) =>
    request.post("/api/push/subscribe", { data: { subscription: subscription(n) }, headers: tz ? { "X-Timezone": tz } : {} });
  expect((await (await request.get("/api/push/key")).json()).key).toMatch(/^B[\w-]{80,}$/);
  expect(await (await sub(1, "America/Chicago")).json()).toMatchObject({ ok: true });
  // Re-sent on every open (idempotent); the service worker's re-subscribe has no zone and keeps it.
  await sub(1);
  expect(sql("SELECT tz FROM push_subscriptions WHERE endpoint = 'https://push.example.test/device-1'")).toEqual([{ tz: "America/Chicago" }]);
  expect((await request.post("/api/push/subscribe", { data: { subscription: { endpoint: "http://x" } } })).status()).toBe(400);

  const test = await (await request.post("/api/push/test")).json();
  expect(test).toMatchObject({ failed: 0 });
  expect(test.sent).toBeGreaterThanOrEqual(1);

  await openApp(page, "#/settings");
  await expect(page.locator(".reminders")).toContainText("10:30");

  await request.post("/api/push/unsubscribe", { data: { endpoint: subscription(1).endpoint } });
  expect(sql("SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = 'https://push.example.test/device-1'")).toEqual([{ n: 0 }]);
});

test("the cron run sends a nightly reminder once, to a user whose evening it is", async ({ request }) => {
  // A zone where it's between 10:30 pm and midnight right now, if there is one.
  const now = new Date();
  const utcMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  const zones = ["Pacific/Kiritimati", "Pacific/Auckland", "Asia/Tokyo", "Asia/Kolkata", "Europe/Berlin", "UTC", "America/Sao_Paulo", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Pago_Pago"];
  const local = (tz: string) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value]));
    return Number(p.hour) * 60 + Number(p.minute);
  };
  const tz = zones.find((z) => local(z) >= 22 * 60 + 30 && local(z) < 23 * 60 + 55);
  test.skip(!tz, `no listed zone is at 10:30–11:55 pm at ${utcMin} UTC minutes`);

  sql("DELETE FROM reminders_sent");
  await request.post("/api/push/subscribe", { data: { subscription: subscription(2) }, headers: { "X-Timezone": tz! } });
  for (let i = 0; i < 2; i++) expect((await request.get("/cdn-cgi/handler/scheduled?cron=*/15+*+*+*+*")).status()).toBe(200);
  const sent = sql("SELECT kind, result FROM reminders_sent");
  expect(sent).toHaveLength(1);
  expect(sent[0].kind).toBe("nightly");
  expect(JSON.parse(sent[0].result as string)).toMatchObject({ failed: 0 });
  await request.post("/api/push/unsubscribe", { data: { endpoint: subscription(2).endpoint } });
});
