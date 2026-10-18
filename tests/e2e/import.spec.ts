import { readFileSync } from "node:fs";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { fixture, openApp, seedMeal } from "./helpers";

test.describe.configure({ mode: "serial" });

// The first real reply (2026-10-18), re-pointed at whatever batch the test creates.
const realReply = JSON.parse(readFileSync(fixture("replies/real-2026-10-18.txt"), "utf8"));
const replyFor = (batchId: string, edit: (r: any) => void = () => {}) => {
  const r = structuredClone(realReply);
  r.batch_id = batchId;
  edit(r);
  return r;
};

async function clearPending(request: APIRequestContext) {
  for (const b of (await (await request.get("/api/batches?status=open")).json()).batches) await request.post(`/api/batches/${b.id}/abandon`);
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
}

test("a pasted reply becomes analyses on the meals, and the batch's summary is shown", async ({ page, request }) => {
  await clearPending(request);
  await seedMeal(request, "2026-10-17T20:12:00-05:00", "curry night", "dinner");
  await seedMeal(request, "2026-10-18T11:20:00-05:00", "shake", "snack");

  await openApp(page, "#/analyze");
  await page.getByRole("button", { name: /Create batch · 2 meals/ }).click();
  const card = page.locator(".batch");
  await expect(card).toBeVisible();
  const batchId = (await (await request.get("/api/batches?status=open")).json()).batches[0].id;

  // Chat apps wrap the JSON in a fence and add a sentence or two: that must still import.
  const pasted = "Here's the analysis:\n\n```json\n" + JSON.stringify(replyFor(batchId), null, 2) + "\n```\nHope that helps!";
  await card.locator("textarea").fill(pasted);
  await card.getByPlaceholder(/Claude/).fill("Claude Opus (Claude app)");
  await card.getByRole("button", { name: "Import reply" }).click();
  await expect(page.locator(".toast")).toContainText("Imported: 2 meals analyzed");
  await expect(page.locator(".batch")).toHaveCount(0);
  await expect(page.locator(".summary")).toContainText("solid start to the log");
  await expect(page.locator(".summary .suggestion")).toContainText("lassi");
  await expect(page.getByText("No meals waiting.")).toBeVisible();

  await page.goto("/#/timeline");
  const curry = page.locator(".meal", { hasText: "curry night" });
  await expect(curry.locator(".meal-analysis")).toContainText("tomato-cream curry with chicken or paneer cubes, no rice · ~400 kcal · P25");
  await curry.locator("a.meal-link").click();
  await expect(page.locator(".analysis")).toContainText("protein 25 g · carbs 18 g · fat 25 g");
  await expect(page.locator(".analysis")).toContainText("Claude Opus (Claude app)");
  await expect(page.locator(".analysis")).toContainText("low confidence");
});

test("a bad reply is refused with reasons, and nothing is stored", async ({ page, request }) => {
  await clearPending(request);
  const a = await seedMeal(request, "2026-10-16T13:00:00-05:00", "bad reply A");
  const b = await seedMeal(request, "2026-10-16T19:00:00-05:00", "bad reply B");
  const batchId = (await (await request.post("/api/batches", { data: { meal_ids: [a, b] } })).json()).batch.id;

  await openApp(page, "#/analyze");
  const card = page.locator(".batch");
  await card.locator("textarea").fill(JSON.stringify(replyFor(batchId, (r) => r.meals.pop())));
  await card.getByPlaceholder(/Claude/).fill("test model");
  await card.getByRole("button", { name: "Import reply" }).click();
  await expect(card.locator(".errors")).toContainText("The reply is missing meal B.");

  await card.locator("textarea").fill(JSON.stringify(replyFor("01OTHERBATCH")));
  await card.getByRole("button", { name: "Import reply" }).click();
  await expect(card.locator(".errors")).toContainText("wrong batch");

  await card.locator("textarea").fill("I couldn't see the photos, sorry.");
  await card.getByRole("button", { name: "Import reply" }).click();
  await expect(card.locator(".errors")).toContainText("No JSON object found");

  const open = (await (await request.get("/api/batches?status=open")).json()).batches;
  expect(open.map((x: { id: string }) => x.id)).toEqual([batchId]); // still open, nothing imported
  expect((await (await request.get(`/api/meals/${a}`)).json()).meal.analyses).toEqual([]);
  await request.post(`/api/batches/${batchId}/abandon`);
});

test("a skipped meal stays ready to analyze, and a batch can't be imported twice", async ({ request }) => {
  await clearPending(request);
  const a = await seedMeal(request, "2026-10-15T13:00:00-05:00", "skip A");
  const b = await seedMeal(request, "2026-10-15T19:00:00-05:00", "skip B");
  const batchId = (await (await request.post("/api/batches", { data: { meal_ids: [a, b] } })).json()).batch.id;
  const reply = replyFor(batchId, (r) => Object.assign(r.meals[1], { skipped: true, skip_reason: "photo too dark", description: null }));
  const res = await request.post(`/api/batches/${batchId}/import`, { data: { reply: JSON.stringify(reply), model: "test model" } });
  expect(res.status()).toBe(200);
  expect((await res.json()).skipped).toEqual([{ key: "B", reason: "photo too dark" }]);

  const pending = (await (await request.get("/api/batches/pending-meals")).json()).meals.map((m: { id: string }) => m.id);
  expect(pending).toEqual([b]);
  const again = await request.post(`/api/batches/${batchId}/import`, { data: { reply: JSON.stringify(reply), model: "test model" } });
  expect(again.status()).toBe(409);
});

test("remembered foods and notes carry into the next batch's prompt, and can be retired", async ({ page, request }) => {
  await clearPending(request);
  const a = await seedMeal(request, "2026-10-14T13:00:00-05:00", "memory A");
  const b = await seedMeal(request, "2026-10-14T19:00:00-05:00", "memory B");
  const first = (await (await request.post("/api/batches", { data: { meal_ids: [a, b] } })).json()).batch.id;
  const reply = replyFor(first, (r) =>
    r.remember.push({ action: "add", code: null, name: "usual lassi shake", serving: "16 oz", kcal: 460, protein_g: 32, carbs_g: 65, fat_g: 8, reason: "recurring" }),
  );
  const imported = await (await request.post(`/api/batches/${first}/import`, { data: { reply: JSON.stringify(reply), model: "test model" } })).json();
  const code = imported.remembered[0].code;
  expect(imported.remembered).toEqual([{ action: "add", code, name: "usual lassi shake" }]);

  await openApp(page, "#/memory");
  await expect(page.locator(".memory .meal", { hasText: code })).toContainText("usual lassi shake");
  await page.getByPlaceholder("Add a note…").fill("My lassi shake: 1 cup 2% yogurt, 1 banana, 1 scoop whey.");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect
    .poll(() => page.locator(".memory .card textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)))
    .toContain("My lassi shake: 1 cup 2% yogurt, 1 banana, 1 scoop whey.");

  const c = await seedMeal(request, "2026-10-18T09:00:00-05:00", "memory C");
  let prompt = (await (await request.post("/api/batches", { data: { meal_ids: [c] } })).json()).batch.prompt as string;
  expect(prompt).toMatch(/Notes: [^]*My lassi shake: 1 cup 2% yogurt, 1 banana, 1 scoop whey\./);
  expect(prompt).toContain(`[${code}] usual lassi shake · 16 oz · 460 kcal`);
  expect(prompt).toContain("tomato-cream curry with chicken or paneer cubes, no rice · ~400 kcal"); // digest of meal A
  expect(prompt).toContain("suggest I add it to my notes in Bitebook");

  await page.locator(".memory .meal", { hasText: code }).getByRole("button", { name: "Retire" }).click();
  const activeRow = page.locator(".memory .meal", { hasText: "usual lassi shake", has: page.getByRole("button", { name: "Retire" }) });
  await expect(activeRow).toHaveCount(0);
  await expect(page.locator("details")).toContainText("Retired");
  for (const bt of (await (await request.get("/api/batches?status=open")).json()).batches) await request.post(`/api/batches/${bt.id}/abandon`);
  prompt = (await (await request.post("/api/batches", { data: { meal_ids: [c] } })).json()).batch.prompt;
  expect(prompt).not.toContain("usual lassi shake ·");
});

test("the reply's own model name fills the Model box, and both it and the confirmed name are kept", async ({ page, request }) => {
  await clearPending(request);
  const a = await seedMeal(request, "2026-10-13T13:00:00-05:00", "model A");
  const b = await seedMeal(request, "2026-10-13T19:00:00-05:00", "model B");
  const batchId = (await (await request.post("/api/batches", { data: { meal_ids: [a, b] } })).json()).batch.id;

  await openApp(page, "#/analyze");
  const card = page.locator(".batch");
  const modelBox = card.getByPlaceholder(/Claude/);
  await card.locator("textarea").fill(JSON.stringify(replyFor(batchId, (r) => (r.model = "claude-opus-5-5"))));
  await expect(modelBox).toHaveValue("claude-opus-5-5");
  await expect(card.getByText("Filled in from the reply")).toBeVisible();

  // The user knows better (say, the app showed a different model): their name wins.
  await modelBox.fill("Claude Opus 5.5 (Claude app)");
  await card.getByRole("button", { name: "Import reply" }).click();
  await expect(page.locator(".toast")).toContainText("Imported: 2 meals analyzed");

  const done = (await (await request.get("/api/batches?status=imported")).json()).batches.find((x: { id: string }) => x.id === batchId);
  expect(done.reply_model).toBe("Claude Opus 5.5 (Claude app)");
  expect(done.reply_model_reported).toBe("claude-opus-5-5");
  const meal = (await (await request.get(`/api/meals/${a}`)).json()).meal;
  expect(meal.analyses[0].model).toBe("Claude Opus 5.5 (Claude app)");
});
