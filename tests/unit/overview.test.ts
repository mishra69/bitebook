import { describe, expect, it } from "vitest";
import { dayWindow, usualDay, type Overview } from "../../src/app/lib/overview";

const day = (date: string, meals: number, analyzed: number, kcal: number, protein_g = 80) => ({
  date, meals, analyzed, analyzing: 0, kcal, protein_g, carbs_g: 0, fat_g: 0, fiber_g: 0, fiber_meals: 0,
});
const o = (days: ReturnType<typeof day>[]): Overview => ({ days, questions: [], latest: null, auto_model: null, chat_waiting: 0 });
const today = new Date(2026, 9, 25, 15, 0); // Oct 25, local

describe("day totals", () => {
  it("fills every day in the window, newest first, and marks fully analyzed ones", () => {
    const w = dayWindow(o([day("2026-10-25", 2, 1, 900), day("2026-10-23", 3, 3, 2100)]), 3, today);
    expect(w.map((d) => [d.date, d.meals, d.complete])).toEqual([["2026-10-25", 2, false], ["2026-10-24", 0, false], ["2026-10-23", 3, true]]);
  });
  it("makes a usual day from the 7 days before today, fully analyzed ones only", () => {
    const u = usualDay(o([
      day("2026-10-25", 2, 2, 900, 40), // today: not part of the usual day
      day("2026-10-24", 3, 3, 2000, 70),
      day("2026-10-23", 3, 2, 800, 30), // half analyzed: left out
      day("2026-10-22", 4, 4, 2200, 90),
      day("2026-10-17", 3, 3, 5000, 99), // 8 days back: outside
    ]), today);
    expect(u).toEqual({ days: 2, kcal: 2100, protein_g: 80 });
    expect(usualDay(o([]), today)).toBeNull();
  });
});
