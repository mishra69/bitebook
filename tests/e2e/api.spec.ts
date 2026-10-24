import { expect, test, type APIRequestContext } from "@playwright/test";
import { openApp, seedMeal, sql } from "./helpers";

// The API path (D27, D28) against a stub provider (OPENROUTER_STUB): the queue, the import,
// the model's questions, corrections and the cost record. The real call is checked live.
test.describe.configure({ mode: "serial" });

const cron = (request: APIRequestContext) => request.get("/cdn-cgi/handler/scheduled?cron=*+*+*+*+*");
const mealOf = async (request: APIRequestContext, id: string) => (await (await request.get(`/api/meals/${id}`)).json()).meal;

// Leave nothing behind for the other specs: these meals are dated today, so they'd show on
// Today and in every later prompt's trend.
const created: string[] = [];
const seed = async (request: APIRequestContext, at: string, note: string) => {
  const id = await seedMeal(request, at, note);
  created.push(id);
  return id;
};
test.afterAll(async ({ request }) => {
  await request.put("/api/analysis/settings", { data: { model: null } });
  for (const id of created) await request.delete(`/api/meals/${id}`);
});

test("with automatic analysis on, a new meal is analyzed by the cron run and its cost recorded", async ({ page, request }) => {
  await openApp(page, "#/memory");
  const card = page.locator(".auto-analysis");
  await expect(card).toContainText("Off");
  await card.locator(".model-input").fill("anthropic/claude-opus-5.5");
  await card.getByRole("button", { name: "Turn on" }).click();
  await expect(card).toContainText("On · anthropic/claude-opus-5.5");

  const id = await seed(request, "2026-10-24T13:00:00-05:00", "api lunch");
  expect((await mealOf(request, id)).api.job.status).toBe("queued");
  // Queued meals aren't offered for a chat batch.
  const pending = (await (await request.get("/api/batches/pending-meals")).json()).meals.map((m: { id: string }) => m.id);
  expect(pending).not.toContain(id);

  expect((await cron(request)).status()).toBe(200);
  await expect.poll(async () => (await mealOf(request, id)).analyses.length, { timeout: 15_000 }).toBe(1);
  const meal = await mealOf(request, id);
  expect(meal.analyses[0]).toMatchObject({ description: "stub estimate", kcal: 500, fiber_g: 6, model: "anthropic/claude-opus-5.5 (stub)" });
  expect(meal.api.job.status).toBe("done");
  const [batch] = sql(`SELECT channel, prompt_version, cost_usd, input_tokens FROM batches WHERE id = (SELECT batch_id FROM analyses WHERE meal_id = '${id}')`);
  expect(batch).toEqual({ channel: "api", prompt_version: "prompt/10", cost_usd: 0.01, input_tokens: 1000 });
  // API runs never show up as open batches to hand over on Analyze.
  expect((await (await request.get("/api/batches?status=open")).json()).batches.every((b: { id: string }) => b.id !== meal.id)).toBe(true);

  await page.reload();
  await expect(page.locator(".usage")).toContainText("Last 7 days");
});

test("the model's question is answered on the meal, and the meal is re-estimated with the answer", async ({ page, request }) => {
  const id = await seed(request, "2026-10-24T19:00:00-05:00", "dinner ASK");
  await cron(request);
  await expect.poll(async () => (await mealOf(request, id)).api.questions.length, { timeout: 15_000 }).toBe(1);

  await openApp(page, `#/meal/${id}`);
  const qs = page.locator(".questions");
  await expect(qs).toContainText("Was that a full plate or half?");
  await qs.getByPlaceholder("Your answer").fill("half a plate");
  await qs.getByRole("button", { name: "Send answers" }).click();
  await expect(page.locator(".api-status")).toContainText(/Revising|Analyzing/);

  await cron(request);
  await expect(page.locator(".analysis").first()).toContainText("revised: You asked: Was that a full plate or half? My answer: half a plate", { timeout: 15_000 });
  await expect(page.locator(".analysis")).toHaveCount(2); // the first estimate is kept
  await expect(page.locator(".questions")).toHaveCount(0);
  // The answered question joins "already asked" for every later prompt.
  expect(sql(`SELECT answer FROM questions WHERE meal_id = '${id}'`)).toEqual([{ answer: "half a plate" }]);
});

test("a correction re-estimates the meal; spoken words are transcribed into the box", async ({ page, request }) => {
  const id = await seed(request, "2026-10-24T08:00:00-05:00", "api breakfast");
  await cron(request);
  await expect.poll(async () => (await mealOf(request, id)).analyses.length, { timeout: 15_000 }).toBe(1);

  await openApp(page, `#/meal/${id}`);
  await page.getByRole("button", { name: "Something wrong? Correct this" }).click();
  const box = page.locator(".correct");
  await box.getByRole("button", { name: "🎙 Say it" }).click();
  await page.waitForTimeout(1200);
  await box.getByRole("button", { name: /tap to stop/ }).click();
  await expect(box.locator("textarea")).toHaveValue(/^\(test transcript of \d+ bytes\)$/);
  await box.locator("textarea").fill("it was two eggs, not one");
  await box.getByRole("button", { name: "Send correction" }).click();

  await cron(request);
  await expect(page.locator(".analysis").first()).toContainText("revised: My correction: it was two eggs, not one", { timeout: 15_000 });
});

test("signed photo links are refused when tampered with", async ({ request }) => {
  expect((await request.get("/img/01M5KCYQ41B5HRM6C2HSJ37BDG/9999999999999/AAAA.jpg")).status()).toBe(403);
  expect((await request.get("/img/not-a-photo/1/x.jpg")).status()).toBe(403);
});
