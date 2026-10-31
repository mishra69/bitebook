import { expect, test } from "@playwright/test";
import { openApp, seedMeal } from "./helpers";

test("earlier days are rows with totals that open to their meals, and older days load on scroll", async ({ page, request }) => {
  test.setTimeout(150_000);
  // One meal a day for 35 days ending Oct 10 (local); all but Oct 10 get analyzed.
  const ids: string[] = [];
  for (let i = 0; i < 35; i++) {
    const day = new Date(Date.UTC(2026, 9, 10) - i * 86_400_000).toISOString().slice(0, 10);
    ids.push(await seedMeal(request, `${day}T13:00:00-05:00`, `day ${i}`));
  }
  // And one yesterday, analyzed: yesterday starts open anyway.
  const y = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  ids.push(await seedMeal(request, `${y}T13:00:00-05:00`, "yesterday's lunch"));
  await request.put("/api/analysis/settings", { data: { model: "anthropic/claude-opus-5.5" } });
  await request.post("/api/analysis/queue-pending", { data: { meal_ids: ids.slice(1) } });
  await expect
    .poll(async () => {
      const { days } = await (await request.get("/api/days?before=2026-10-10&limit=40")).json();
      return days.filter((d: { date: string; analyzed: number }) => d.date >= "2026-09-06" && d.analyzed > 0).length;
    }, { timeout: 120_000 })
    .toBe(34);
  await expect.poll(async () => (await (await request.get(`/api/meals/${ids[35]}`)).json()).meal.analyses.length).toBeGreaterThan(0);
  await request.put("/api/analysis/settings", { data: { model: null } });

  await openApp(page);
  const row = (label: string) => page.locator("li.day", { has: page.locator(".day-title strong", { hasText: label }) });
  // Not analyzed: open, with its meal showing. Analyzed: closed, with the day's totals.
  await expect(row("Sat, Oct 10").locator(".day-head")).toHaveAttribute("aria-expanded", "true");
  await expect(row("Sat, Oct 10").locator(".meal", { hasText: "day 0" })).toHaveCount(1);
  const oct9 = row("Fri, Oct 9");
  await expect(oct9.locator(".day-head")).toHaveAttribute("aria-expanded", "false");
  await expect(oct9.locator(".day-macros")).toContainText(/[\d,]+ kcal · P \d+ · C \d+ · F \d+/);
  await expect(oct9.locator(".meal")).toHaveCount(0);
  await expect(row("Yesterday").locator(".day-head")).toHaveAttribute("aria-expanded", "true");
  await expect(row("Yesterday").locator(".meal", { hasText: "yesterday's lunch" })).toHaveCount(1);

  await oct9.locator(".day-head").click();
  await expect(oct9.locator(".meal", { hasText: "day 1" }).locator(".meal-analysis")).toContainText("kcal");
  await oct9.locator(".day-head").click();
  await expect(oct9.locator(".meal")).toHaveCount(0);

  // 30 days at a time: the oldest arrive by scrolling down.
  await expect(row("Sun, Sep 6")).toHaveCount(0);
  await page.locator(".more").scrollIntoViewIfNeeded();
  await expect(row("Sun, Sep 6")).toHaveCount(1);

  // Open a meal, delete it, undo.
  await oct9.locator(".day-head").click();
  await oct9.locator(".meal", { hasText: "day 1" }).locator("a.meal-link").click();
  await expect(page.locator(".detail h2")).toContainText("October 9");
  await page.getByRole("button", { name: "Delete meal" }).click();
  await expect(page.locator(".toast")).toContainText("Deleted 13:00 lunch");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.locator(".meal", { hasText: "day 1" })).toHaveCount(0);
  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(row("Fri, Oct 9")).toHaveCount(1);
});

test("a deleted meal can be restored from Recently deleted", async ({ page, request }) => {
  const id = await seedMeal(request, "2026-09-30T12:00:00-05:00", "to restore");
  await request.delete(`/api/meals/${id}`);
  await openApp(page);
  await expect(page.locator(".meal", { hasText: "to restore" })).toHaveCount(0);
  await page.getByRole("button", { name: "Recently deleted" }).click();
  await page.locator(".meals.deleted .meal", { hasText: "2026-09-30" }).getByRole("button", { name: "Restore" }).click();
  await expect(page.locator(".toast")).toContainText("Meal restored.");
  // Other specs add newer meals, so it may sit past the first page: check it directly.
  await expect.poll(async () => (await request.get(`/api/meals/${id}`)).status()).toBe(200);
  await expect(page.locator(".meals.deleted .meal", { hasText: "2026-09-30" })).toHaveCount(0);
});

test("an unknown meal shows a not-found message", async ({ page }) => {
  await openApp(page, "#/meal/01M56K00000000000000000009");
  await expect(page.getByText("doesn't exist or was deleted")).toBeVisible();
});

test("the API refuses bad uploads and incomplete meals", async ({ request }) => {
  const id = "01M55F0000000000000000TEST";
  const sha = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"; // sha256("hello")
  const put = (headers: Record<string, string>, data = "hello") =>
    request.put(`/api/photos/${id}/original`, { headers: { "X-Taken-At": "2026-10-17T12:00:00-05:00", ...headers }, data });
  expect((await put({ "Content-Type": "image/jpeg", "X-Sha256": "0".repeat(64) })).status()).toBe(422);
  expect((await put({ "Content-Type": "text/plain", "X-Sha256": sha })).status()).toBe(415);
  expect((await put({ "Content-Type": "image/jpeg", "X-Sha256": sha })).status()).toBe(200);

  const meal = {
    id: "01M55F000000000000000ME001", taken_at: "2026-10-17T12:00:00-05:00", tz: "America/Chicago", meal_type: null, note: null,
    photos: [{ id, position: 0, mime: "image/jpeg", bytes: 5, sha256: sha, display_bytes: 5, display_sha256: sha, width: null, height: null }],
  };
  const missing = await request.post("/api/meals", { data: meal });
  expect(missing.status()).toBe(409); // the display copy was never uploaded
  expect((await missing.json()).missing).toEqual([`${id}/display`]);
  expect((await request.post("/api/meals", { data: { ...meal, meal_type: "brunch" } })).status()).toBe(400);
  // No photo is allowed only with a description (D24).
  const bare = await request.post("/api/meals", { data: { ...meal, photos: [] } });
  expect(bare.status()).toBe(400);
  expect((await bare.json()).detail).toBe("photos");
});
