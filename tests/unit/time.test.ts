import { beforeAll, describe, expect, it } from "vitest";
import { localIso, timeOfDay, withLocalOffset } from "../../src/app/lib/time";

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
});
