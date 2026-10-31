import { beforeAll, describe, expect, it } from "vitest";
import { daysAgoOf, localIso, missedMealOnDay, missedMealTime, suggestMealType, timeOfDay, withLocalOffset } from "../../src/app/lib/time";

beforeAll(() => {
  process.env.TZ = "America/Chicago"; // Node re-reads TZ when it's assigned
});

describe("time helpers", () => {
  it("formats local time with the device's offset, across DST", () => {
    expect(localIso(new Date("2026-10-17T00:32:05Z"))).toBe("2026-10-16T19:32:05-05:00"); // CDT
    expect(localIso(new Date("2026-12-01T18:00:00Z"))).toBe("2026-12-01T12:00:00-06:00"); // CST
  });
  it("interprets offset-less EXIF time in the device zone", () => {
    expect(withLocalOffset("2026-10-16T08:05:00")).toBe("2026-10-16T08:05:00-05:00");
  });
  it("reads the local clock time back out", () => {
    expect(timeOfDay("2026-10-16T19:32:05+05:30")).toBe("19:32");
  });
  // D39: a missed meal starts at now and steps back an hour at a time.
  const now = new Date("2026-10-28T02:47:30Z"); // 21:47 on Oct 27 in Chicago
  it("steps a missed meal's time by the hour, never past now or before yesterday", () => {
    const start = missedMealTime(localIso(now), 0, now);
    expect(start).toBe("2026-10-27T21:47:00-05:00");
    expect(missedMealTime(start, -1, now)).toBe("2026-10-27T20:47:00-05:00");
    expect(missedMealTime(start, 1, now)).toBe(start); // not after now
    expect(missedMealTime("2026-10-26T00:30:00-05:00", -1, now)).toBe("2026-10-26T00:00:00-05:00"); // yesterday's start
  });
  it("moves a missed meal to today or yesterday at the same clock time, no later than now", () => {
    expect(missedMealOnDay("2026-10-27T13:15:00-05:00", 1, now)).toBe("2026-10-26T13:15:00-05:00");
    expect(missedMealOnDay("2026-10-26T23:15:00-05:00", 0, now)).toBe("2026-10-27T21:47:30-05:00");
    expect(daysAgoOf("2026-10-26T23:15:00-05:00", now)).toBe(1);
    expect(daysAgoOf("2026-10-27T00:05:00-05:00", now)).toBe(0);
  });
  it("suggests a meal type from the time of day", () => {
    expect(suggestMealType("2026-10-27T08:30:00-05:00")).toBe("breakfast");
    expect(suggestMealType("2026-10-27T21:47:00-05:00")).toBe("dinner");
    expect(suggestMealType("2026-10-27T23:10:00-05:00")).toBe("snack");
  });
});
