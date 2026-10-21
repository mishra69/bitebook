import { expect, test } from "@playwright/test";
import { openApp, seedMeal, serverMeal, sql, ulid } from "./helpers";

test.describe.configure({ mode: "serial" });

test("pending meals become a batch whose prompt and photos can be handed to a chat app", async ({ page, request, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  // Earlier spec files leave meals behind; start this test with none pending.
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
  await seedMeal(request, "2026-10-11T08:10:00-05:00", "oats", "breakfast");
  await seedMeal(request, "2026-10-11T13:00:00-05:00", "wrap", "lunch");
  await seedMeal(request, "2026-10-11T19:45:00-05:00", "dal", "dinner");

  await openApp(page, "#/analyze");
  await expect(page.locator(".pick input:checked")).toHaveCount(3);
  await page.getByRole("button", { name: /Create batch · 3 meals, 3 photos/ }).click();
  const card = page.locator(".batch");
  await expect(card).toContainText("Open batch · 3 meals, 3 photos");
  await expect(page.getByText("Every saved meal is in a batch.")).toBeVisible();
  await expect(card.locator("figcaption")).toHaveText(["A", "B", "C"]);

  const { batches } = await (await request.get("/api/batches?status=open")).json();
  expect(batches).toHaveLength(1);
  const prompt: string = batches[0].prompt;
  expect(prompt).toContain(`Batch: ${batches[0].id}`);
  expect(prompt).toContain("[A] Sun 2026-10-11 08:10 · breakfast · photos: A-1_2026-10-11_0810.jpg (08:10)\nNote: oats");
  expect(prompt).toContain("[C] Sun 2026-10-11 19:45 · dinner · photos: C-1_2026-10-11_1945.jpg (19:45)\nNote: dal");

  await card.getByRole("button", { name: "Copy prompt" }).click();
  await expect(card.getByRole("button", { name: "Prompt copied ✓" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);

  // Desktop Chromium on Linux can't share files, so the same button downloads them.
  const shareOrDownload = card.getByRole("button", { name: /Share photos|Download photos/ });
  await expect(shareOrDownload).toBeEnabled();
  if ((await shareOrDownload.textContent()) === "Download photos") {
    const names: string[] = [];
    page.on("download", (d) => names.push(d.suggestedFilename()));
    await shareOrDownload.click();
    await expect.poll(() => names.sort()).toEqual(["A-1_2026-10-11_0810.jpg", "B-1_2026-10-11_1300.jpg", "C-1_2026-10-11_1945.jpg"]);
  }

  // Abandoning releases the meals for another batch.
  page.once("dialog", (d) => d.accept());
  await card.getByRole("button", { name: "Abandon batch" }).click();
  await expect(page.locator(".batch")).toHaveCount(0);
  await expect(page.locator(".pick input:checked")).toHaveCount(3);
});

test("a batch holds at most 20 photos, and a meal can be in only one open batch", async ({ page, request }) => {
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
  const ids: string[] = [];
  for (let i = 0; i < 21; i++) ids.push(await seedMeal(request, `2026-10-0${1 + (i % 9)}T12:${String(10 + i).padStart(2, "0")}:00-05:00`, `cap ${i}`));

  expect((await request.post("/api/batches", { data: { meal_ids: ids } })).status()).toBe(413);
  await openApp(page, "#/analyze");
  await expect(page.locator(".pick input:checked")).toHaveCount(20); // oldest 20 preselected
  await page.locator(".pick input:not(:checked)").check();
  await expect(page.getByRole("button", { name: /Create batch/ })).toBeDisabled();
  await expect(page.getByText("Too many photos for one message")).toBeVisible();

  const first = await request.post("/api/batches", { data: { meal_ids: ids.slice(0, 2) } });
  expect(first.status()).toBe(201);
  expect((await request.post("/api/batches", { data: { meal_ids: ids.slice(1, 3) } })).status()).toBe(409);
  await request.post(`/api/batches/${(await first.json()).batch.id}/abandon`);
});

test("the prompt carries notes, remembered foods, the 30-day digest and the trend", async ({ request }) => {
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
  const recent = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
  const analyzed = await seedMeal(request, `${recent}T19:30:00-05:00`, "analyzed already", "dinner");
  const user = "dev-user", now = new Date().toISOString(), batch = ulid();
  sql(`INSERT INTO batches (id, user_id, created_at, prompt_version, prompt_text, key_map, active_codes, status)
       VALUES ('${batch}', '${user}', '${now}', 'prompt/1', 'x', '{"A":"${analyzed}"}', '[]', 'imported')`);
  sql(`INSERT INTO analyses (id, user_id, meal_id, batch_id, model, prompt_version, schema_version, payload, created_at)
       VALUES ('${ulid()}', '${user}', '${analyzed}', '${batch}', 'test-model', 'prompt/1', 'bitebook.reply/1',
               '{"description":"dal tadka with 2 rotis","kcal":550,"protein_g":20,"carbs_g":75,"fat_g":18,"foods_used":["F1"]}', '${now}')`);
  sql(`INSERT INTO foods (id, user_id, code, name, serving, kcal, protein_g, carbs_g, fat_g, created_at, updated_at)
       VALUES ('${ulid()}', '${user}', 'F1', 'Mission whole wheat tortilla', '1 tortilla (45 g)', 130, 4, 22, 3.5, '${now}', '${now}')`);
  sql(`INSERT INTO notes (id, user_id, body, created_at, updated_at) VALUES ('${ulid()}', '${user}', 'My usual bowl is 400 ml.', '${now}', '${now}')`);

  const pending = (await (await request.get("/api/batches/pending-meals")).json()).meals;
  expect(pending.map((m: { id: string }) => m.id)).not.toContain(analyzed); // analyzed meals aren't pending
  const meal = await seedMeal(request, "2026-10-17T12:00:00-05:00", "new one");
  const res = await request.post("/api/batches", { data: { meal_ids: [meal] } });
  expect(res.status()).toBe(201);
  const { prompt } = (await res.json()).batch;
  expect(prompt).toContain("Notes: My usual bowl is 400 ml.");
  expect(prompt).toContain("[F1] Mission whole wheat tortilla · 1 tortilla (45 g) · 130 kcal · P4 C22 F3.5");
  expect(prompt).toMatch(/19:30 dinner · dal tadka with 2 rotis · ~550 kcal · P20 C75 F18 \[F1\]/);
  expect(prompt).toContain("Last 7 days: 1 day logged · avg 550 kcal/day · protein 20 g/day");
});

test("helpings show in the prompt with each photo's own time", async ({ request }) => {
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
  const meal = await seedMeal(request, "2026-10-20T19:32:05-05:00", "two helpings", "dinner", [
    "2026-10-20T19:32:05-05:00",
    "2026-10-20T19:48:40-05:00",
  ]);
  const res = await request.post("/api/batches", { data: { meal_ids: [meal] } });
  const { batch } = await res.json();
  expect(batch.prompt).toContain("photos: A-1_2026-10-20_1932.jpg (19:32), A-2_2026-10-20_1948.jpg (19:48, +16 min)");
  expect(batch.entries[0].files.map((f: { name: string }) => f.name)).toEqual(["A-1_2026-10-20_1932.jpg", "A-2_2026-10-20_1948.jpg"]);
  await request.post(`/api/batches/${batch.id}/abandon`);
});

test("a voice note's transcript goes into the prompt", async ({ page, request }) => {
  for (const m of (await (await request.get("/api/batches/pending-meals")).json()).meals) await request.delete(`/api/meals/${m.id}`);
  await openApp(page);
  await page.getByRole("button", { name: "New meal" }).click();
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/side.png");
  await expect(page.locator(".draft figure.thumb")).toHaveCount(1);
  await page.locator(".draft .note").fill("voice to prompt");
  await page.getByRole("button", { name: /Add a voice note/ }).click();
  await page.waitForTimeout(1500);
  await page.locator(".voice.recording").click();
  await expect(page.locator(".voice.saved")).toBeVisible();
  await page.getByRole("button", { name: "Save meal" }).click();
  const meal = await serverMeal(request, "voice to prompt");
  const { batch } = await (await request.post("/api/batches", { data: { meal_ids: [meal.id] } })).json();
  expect(batch.prompt).toMatch(/Note: voice to prompt\nVoice note \(my words, transcribed\): \(test transcript of \d+ bytes\)/);
  await request.post(`/api/batches/${batch.id}/abandon`);
});
