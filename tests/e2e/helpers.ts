import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const fixture = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

// Loads the app with its service worker in control, as it is on the phone.
export async function openApp(page: Page, hash = "#/") {
  await page.goto("/" + hash);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator(".tabs")).toBeVisible();
}

// Takes photos through the real capture flow and saves the meal.
export async function captureMeal(page: Page, files: string[], note?: string) {
  await page.getByRole("button", { name: "Snap it" }).click();
  for (const [i, f] of files.entries()) {
    await page.locator("input[type=file]").setInputFiles(fixture(f));
    await expect(page.locator(".draft figure.thumb")).toHaveCount(i + 1);
  }
  if (note) await page.locator(".draft .note").fill(note);
  await page.getByRole("button", { name: "Save meal" }).click();
  await expect(page.locator(".draft")).toHaveCount(0);
}

export const allSaved = (page: Page) =>
  expect(page.locator(".sync-line")).toContainText("All meals saved.", { timeout: 30_000 });

// Waits until the server has the meal with this note (more reliable than the status line,
// which reads "All meals saved." for a moment before a new meal reaches the outbox).
export async function serverMeal(request: APIRequestContext, note: string) {
  let found: any;
  await expect
    .poll(async () => {
      const { meals } = await (await request.get("/api/meals")).json();
      found = meals.find((m: { note: string | null }) => m.note === note);
      return Boolean(found);
    }, { timeout: 30_000 })
    .toBe(true);
  return found;
}

// Creates meals straight through the API (the e2e server has sign-in disabled).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(t = Date.now()) {
  let s = "";
  for (let i = 0; i < 10; i++, t = Math.floor(t / 32)) s = ALPHABET[t % 32] + s;
  for (const b of randomBytes(16)) s += ALPHABET[b % 32];
  return s;
}

// photoTimes: each photo's own time (one photo at takenAt by default).
export async function seedMeal(request: APIRequestContext, takenAt: string, note: string, mealType = "lunch", photoTimes = [takenAt]) {
  const jpg = readFileSync(fixture("meal-no-offset.jpg"));
  const sha = createHash("sha256").update(jpg).digest("hex");
  const meal = ulid();
  const photos = [];
  for (const [position, time] of photoTimes.entries()) {
    const photo = ulid();
    for (const kind of ["display", "original"]) {
      const r = await request.put(`/api/photos/${photo}/${kind}`, {
        headers: { "Content-Type": "image/jpeg", "X-Sha256": sha, "X-Taken-At": takenAt },
        data: jpg,
      });
      expect(r.status()).toBe(200);
    }
    photos.push({ id: photo, position, mime: "image/jpeg", bytes: jpg.length, sha256: sha,
      display_bytes: jpg.length, display_sha256: sha, width: 1600, height: 1200, taken_at: time });
  }
  const r = await request.post("/api/meals", {
    data: { id: meal, taken_at: takenAt, tz: "America/Chicago", meal_type: mealType, note, photos },
  });
  expect(r.status()).toBe(201);
  return meal;
}

// Runs SQL against the e2e server's local database (for state no UI creates yet).
import { execFileSync } from "node:child_process";
export function sql(query: string) {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "bitebook-db", "--local", "--persist-to", ".wrangler/e2e-state", "--json", "--command", query],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out)[0].results as Record<string, unknown>[];
}
