import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { openApp, seedMeal } from "./helpers";

// Today's running total, the questions card, the chat-waiting card, and Trends (D30).
test.describe.configure({ mode: "serial" });

const created: string[] = [];
const cron = (request: APIRequestContext) => request.get("/cdn-cgi/handler/scheduled?cron=*+*+*+*+*");
// A time earlier today, on the phone's clock and in its zone.
const todayAt = (page: Page, hour: number) =>
  page.evaluate((h) => {
    const d = new Date();
    d.setHours(h, 0, 0, 0);
    const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00:00${off >= 0 ? "+" : "-"}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
  }, hour);

test.afterAll(async ({ request }) => {
  await request.put("/api/analysis/settings", { data: { model: null } });
  for (const id of created) await request.delete(`/api/meals/${id}`);
});

test("in chat mode, Today points to the meals waiting for a handoff", async ({ page, request }) => {
  await openApp(page);
  created.push(await seedMeal(request, await todayAt(page, 0), "chat waiting"));
  await page.reload();
  const card = page.locator(".chat-waiting");
  await expect(card).toContainText(/\d+ meals? waiting for analysis → Analyze in a chat/);
  await card.click();
  await expect(page.locator(".analyze")).toBeVisible();
  await expect(page.locator(".tabs a[aria-current=page]")).toHaveText("Trends");
});

test("with automatic analysis, Today shows the running total and the model's question", async ({ page, request }) => {
  await request.put("/api/analysis/settings", { data: { model: "anthropic/claude-opus-5.5" } });
  await request.post("/api/analysis/queue-pending"); // the chat-waiting meal above
  await openApp(page);
  created.push(await seedMeal(request, await todayAt(page, 0), "lunch ASK"));
  await cron(request);
  await cron(request);

  await page.reload();
  await expect(page.locator(".chat-waiting")).toHaveCount(0); // nothing for the chat to do
  const total = page.locator(".day-total");
  await expect(total).toContainText(/Today so far: [\d,]+ kcal · protein \d+ g · carbs \d+ g · fat \d+ g · fiber \d+ g/);
  await expect(total).toContainText(/\d+ of \d+ meals analyzed/);

  const qs = page.locator(".waiting-questions");
  await expect(qs).toContainText("Was that a full plate or half?");
  await qs.locator("a.waiting-question").first().click();
  await expect(page.locator(".questions")).toContainText("Was that a full plate or half?");
});

test("Trends charts a nutrient per day, shows the latest comment, and links to the chat handoff", async ({ page }) => {
  await openApp(page, "#/trends");
  await expect(page.locator(".chart .bar")).not.toHaveCount(0);
  await expect(page.locator(".readout")).toContainText(/kcal a day on average, over \d+ fully analyzed days?/);
  await page.getByRole("radio", { name: "protein" }).click();
  await expect(page.locator(".readout")).toContainText(/ g a day on average/);
  await page.getByRole("radio", { name: "30 days" }).click();
  await expect(page.locator(".chart .hit")).toHaveCount(30);
  await page.locator(".chart .hit").last().dispatchEvent("pointerdown");
  await expect(page.locator(".readout")).toContainText(/of \d+ meals? analyzed/);
  await page.locator("details summary").click();
  await expect(page.locator(".trend-table tbody tr")).toHaveCount(30);
  await expect(page.locator(".summary")).toContainText("Stub summary.");
  await page.getByRole("link", { name: "Analyze in a chat instead" }).click();
  await expect(page.locator(".analyze")).toBeVisible();
});
