import { expect, test, type APIRequestContext } from "@playwright/test";
import { openApp, seedMeal, sql } from "./helpers";

// The Apple Health export (D34): what the Shortcut is handed, and that a confirmed run is
// never handed out again. The Shortcut itself (Health samples) can only be checked on an iPhone.
test.describe.configure({ mode: "serial" });

const created: string[] = [];
let key = "";
const shortcut = (request: APIRequestContext, path: string, method: "GET" | "POST" = "GET", k = key) =>
  request.fetch(path, { method, headers: { Authorization: `Bearer ${k}` } });

// An analyzed meal, made to look settled (its estimate over an hour old) or not.
async function analyzedMeal(request: APIRequestContext, takenAt: string, note: string, settled: boolean, fiber: number | null = 6) {
  const id = await seedMeal(request, takenAt, note);
  created.push(id);
  const at = new Date(Date.now() - (settled ? 2 : 0) * 3_600_000).toISOString();
  const payload = JSON.stringify({ key: "A", skipped: false, description: note, kcal: 512.34, protein_g: 20, carbs_g: 60, fat_g: 15, fiber_g: fiber, confidence: "medium", foods_used: [], comment: null });
  sql(`INSERT INTO batches (id, user_id, created_at, prompt_version, prompt_text, key_map, active_codes, status) VALUES ('B${id}', 'dev-user', '${at}', 'prompt/10', 'x', '{"A":"${id}"}', '[]', 'imported')`);
  sql(`INSERT INTO analyses (id, user_id, meal_id, batch_id, model, prompt_version, schema_version, skipped, payload, created_at) VALUES ('A${id}', 'dev-user', '${id}', 'B${id}', 'test', 'prompt/10', 'bitebook.reply/1', 0, '${payload}', '${at}')`);
  return id;
}

test.afterAll(async ({ request }) => {
  await request.delete("/api/apple-health/key");
  for (const id of created) await request.delete(`/api/meals/${id}`);
});

test("the Shortcut gets settled meals once, with a date and plain numbers, and confirms them", async ({ request }) => {
  expect((await shortcut(request, "/shortcut/meals", "GET", "bb_nope")).status()).toBe(401);
  key = (await (await request.post("/api/apple-health/key")).json()).key;
  expect(key).toMatch(/^bb_[\w-]{32}$/);

  const a = await analyzedMeal(request, "2026-10-26T08:30:00-07:00", "health breakfast", true);
  const b = await analyzedMeal(request, "2026-10-26T13:00:00-07:00", "health lunch old estimate", true, null);
  const fresh = await analyzedMeal(request, "2026-10-26T19:00:00-07:00", "health dinner just analyzed", false);

  const first = await (await shortcut(request, "/shortcut/meals")).json();
  const ids = first.meals.map((m: { id: string }) => m.id);
  expect(ids).toEqual(expect.arrayContaining([a, b]));
  expect(ids).not.toContain(fresh); // not settled yet
  const meal = first.meals.find((m: { id: string }) => m.id === a);
  expect(meal).toEqual({ id: a, date: "October 26, 2026 at 8:30 AM", date_iso: "2026-10-26T08:30:00-07:00", kcal: 512.3, protein_g: 20, carbs_g: 60, fat_g: 15, fiber_g: 6 });
  expect(first.meals.find((m: { id: string }) => m.id === b)).not.toHaveProperty("fiber_g"); // unknown, not zero
  expect(first.done_url).toMatch(/\/shortcut\/done\/[0-9A-Z]{26}$/);

  // Not confirmed: handed out again. Confirmed: never again.
  expect((await (await shortcut(request, "/shortcut/meals")).json()).meals.map((m: { id: string }) => m.id)).toContain(a);
  const done = await shortcut(request, new URL(first.done_url).pathname, "POST");
  expect(await done.json()).toMatchObject({ ok: true });
  const next = (await (await shortcut(request, "/shortcut/meals")).json()).meals.map((m: { id: string }) => m.id);
  expect(next).not.toContain(a);
  expect(next).not.toContain(b);

  const status = await (await request.get("/api/apple-health")).json();
  expect(status.sent).toBeGreaterThanOrEqual(2);
  expect(status.last_run.meals).toBeGreaterThanOrEqual(2);
});

test("a meal re-estimated after it was sent is counted, and a revoked key stops working", async ({ request }) => {
  const sentMeal = created[0];
  const at = new Date().toISOString();
  sql(`INSERT INTO analyses (id, user_id, meal_id, batch_id, model, prompt_version, schema_version, skipped, payload, created_at) VALUES ('R${sentMeal}', 'dev-user', '${sentMeal}', 'B${sentMeal}', 'test', 'prompt/10', 'bitebook.reply/1', 0, '{"kcal":700}', '${at}')`);
  expect((await (await request.get("/api/apple-health")).json()).changed_after).toBe(1);

  await request.delete("/api/apple-health/key");
  expect((await shortcut(request, "/shortcut/meals")).status()).toBe(401);
});

test("Settings sets it up: a key shown once, with the Shortcut steps", async ({ page }) => {
  await openApp(page, "#/settings");
  const card = page.locator(".apple-health");
  await card.getByRole("button", { name: "Set up the Shortcut" }).click();
  await expect(card.locator(".mono")).toHaveText(/^bb_[\w-]{32}$/);
  await expect(card.locator(".guide")).toContainText("Log Health Sample");
  await expect(card.locator(".guide")).toContainText("done_url");
  await page.reload();
  await expect(card.locator(".mono")).toHaveCount(0); // never shown again
  await expect(card).toContainText(/^.*On · /); // set up; the earlier run's history stays
});
