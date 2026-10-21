import { expect, test } from "@playwright/test";
import { allSaved, captureMeal, openApp, serverMeal } from "./helpers";

test("a meal uses its photo's EXIF time, survives a reload mid-draft, and uploads", async ({ page, request }) => {
  await openApp(page);
  await page.getByRole("button", { name: "New meal" }).click();
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/meal-with-offset.jpg");
  await expect(page.locator(".chip.on")).toHaveText("dinner"); // 19:32 local
  await page.locator(".draft .note").fill("draft survives reload");
  await page.waitForTimeout(600); // the note is saved after a pause in typing

  // iOS may reload the app while the camera is open: the draft must come back.
  await page.reload();
  await expect(page.locator(".draft figure.thumb")).toHaveCount(1);
  await expect(page.locator(".draft .note")).toHaveValue("draft survives reload");
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/side.png");
  await expect(page.locator(".draft figure.thumb")).toHaveCount(2);
  await page.getByRole("button", { name: "Save meal" }).click();
  const meal = await serverMeal(request, "draft survives reload");
  expect(meal.taken_at).toBe("2026-10-16T19:32:05-05:00");
  expect(meal.meal_type).toBe("dinner");
  expect(meal.photos).toHaveLength(2);
  // Each photo keeps its own time: the first from its EXIF, the second (no EXIF) from capture.
  expect(meal.photos[0].taken_at).toBe("2026-10-16T19:32:05-05:00");
  expect(meal.photos[1].taken_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/);
  expect(meal.photos[1].taken_at).not.toBe(meal.photos[0].taken_at);

  // The display copy is a ~1600 px JPEG, encoded at quality 0.8 (not the browser's default).
  const display = await request.get(`/api/photos/${meal.photos[0].id}/display`);
  expect(display.headers()["content-type"]).toBe("image/jpeg");
  expect((await display.body()).length).toBeLessThan(400_000);
});

test("a meal saved offline waits in the outbox and uploads when the network returns", async ({ page, context, request }) => {
  await openApp(page);
  await context.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await captureMeal(page, ["side.png"], "saved while offline");
  await expect(page.locator(".sync-line")).toContainText(/Offline|waiting to upload/);
  await expect(page.locator(".meal .badge")).toHaveText("uploading");

  await context.unroute("**/api/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await serverMeal(request, "saved while offline");
  await expect(page.locator(".meal", { hasText: "saved while offline" }).locator("a.meal-link")).toHaveCount(1);
});

test("an upload frozen mid-request is abandoned and redone when the app comes back", async ({ page, context, request }) => {
  await openApp(page);
  // iOS freezes a backgrounded app; its in-flight request may never settle.
  await context.route("**/api/photos/*/*", (r) => (r.request().method() === "PUT" ? undefined : r.continue()));
  await captureMeal(page, ["side.png"], "frozen upload");
  await expect(page.locator(".sync-line")).toContainText("Uploading");
  await expect(page.locator(".hint")).toContainText("Keep Bitebook open");

  await context.unroute("**/api/photos/*/*");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await serverMeal(request, "frozen upload");
  await allSaved(page);
});

test("deleting a meal that hasn't uploaded removes it for good", async ({ page, context, request }) => {
  await openApp(page);
  await context.route("**/api/**", (r) => r.abort("internetdisconnected"));
  await captureMeal(page, ["side.png"], "never uploaded");
  page.once("dialog", (d) => d.accept());
  await page.locator(".meal", { hasText: "never uploaded" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.locator(".meal", { hasText: "never uploaded" })).toHaveCount(0);

  await context.unroute("**/api/**");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await allSaved(page);
  const { meals } = await (await request.get("/api/meals")).json();
  expect(meals.some((m: { note: string }) => m.note === "never uploaded")).toBe(false);
});

test("a draft left open for over 90 minutes is saved when the app is next opened", async ({ page, request }) => {
  await openApp(page);
  await page.getByRole("button", { name: "New meal" }).click();
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/side.png");
  await page.locator(".draft .note").fill("left open");
  await page.waitForTimeout(600); // the note is saved after a pause in typing

  // Pretend the last helping was added two hours ago, then come back to the app.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("bitebook");
        open.onsuccess = () => {
          const store = open.result.transaction("outbox", "readwrite").objectStore("outbox");
          const all = store.getAll();
          all.onsuccess = () => {
            const d = all.result.find((m: { draft?: boolean }) => m.draft);
            const twoHoursAgo = Date.now() - 2 * 3600_000;
            d.createdAt = new Date(twoHoursAgo).toISOString();
            for (const p of d.photos) p.addedAt = twoHoursAgo;
            store.put(d).onsuccess = () => resolve();
          };
        };
        open.onerror = () => reject(open.error);
      }),
  );
  await page.reload();
  await expect(page.locator(".toast")).toContainText("meal (1 photo) that was left open");
  await expect(page.locator(".draft")).toHaveCount(0);
  await serverMeal(request, "left open");
});

test("a draft still in progress stays open across a reload", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "New meal" }).click();
  await page.locator("input[type=file]").setInputFiles("tests/fixtures/side.png");
  await expect(page.locator(".draft figure.thumb")).toHaveCount(1); // shown = stored on the phone
  await page.reload();
  await expect(page.locator(".draft figure.thumb")).toHaveCount(1);
  await expect(page.locator(".toast")).toHaveCount(0); // not auto-saved
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Discard" }).click();
  await expect(page.locator(".draft")).toHaveCount(0);
});
