import { expect, test } from "@playwright/test";
import { openApp, seedMeal } from "./helpers";

test("timeline groups by day, pages back, opens a meal, and deletes with undo", async ({ page, request }) => {
  // 45 meals, three a day, ending on Oct 10 (local).
  for (let i = 0; i < 45; i++) {
    const day = new Date(Date.UTC(2026, 9, 10) - Math.floor(i / 3) * 86_400_000).toISOString().slice(0, 10);
    const hour = ["08", "13", "19"][i % 3];
    await seedMeal(request, `${day}T${hour}:00:00-05:00`, `seed ${i}`, ["breakfast", "lunch", "dinner"][i % 3]);
  }

  await openApp(page, "#/timeline");
  await expect(page.locator(".section-title", { hasText: "Sat, Oct 10" })).toBeVisible();
  const firstPage = await page.locator("a.meal-link").count();
  expect(firstPage).toBeGreaterThanOrEqual(40);
  await page.getByRole("button", { name: "Show older meals" }).click();
  await expect(page.locator(".meal", { hasText: "seed 44" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Show older meals" })).toHaveCount(0);

  await page.locator(".meal", { hasText: "seed 0" }).locator("a.meal-link").click();
  await expect(page.locator(".detail h2")).toContainText("October 10");
  await expect(page.locator(".detail-photos img")).toHaveCount(1);
  await page.getByRole("button", { name: "Delete meal" }).click();
  await expect(page.locator(".toast")).toContainText("Deleted 08:00 breakfast");
  await expect(page).toHaveURL(/#\/timeline$/);
  await expect(page.locator(".meal", { hasText: "seed 0" })).toHaveCount(0);

  await page.locator(".toast").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".meal", { hasText: "seed 0" })).toHaveCount(1);
  await page.getByRole("button", { name: "Recently deleted" }).click();
  // Undone, so not listed (the list may not exist at all when nothing else is deleted).
  await expect(page.locator(".meals.deleted", { hasText: "2026-10-10 19:00" })).toHaveCount(0);
});

test("a deleted meal can be restored from Recently deleted", async ({ page, request }) => {
  const id = await seedMeal(request, "2026-09-30T12:00:00-05:00", "to restore");
  await request.delete(`/api/meals/${id}`);
  await openApp(page, "#/timeline");
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
