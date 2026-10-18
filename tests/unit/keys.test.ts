import { describe, expect, it } from "vitest";
import { photoKey } from "../../src/shared/meals";
import { isUlid, ulid } from "../../src/shared/ulid";

describe("R2 keys (SPEC §5)", () => {
  it("files photos under the user, by the meal's local month", () => {
    expect(photoKey("U1", "original", "P1", "2026-10-31T23:30:00-05:00", "image/jpeg")).toBe("users/U1/originals/2026/10/P1.jpg");
    expect(photoKey("U1", "display", "P1", "2026-11-01T00:30:00+01:00", "image/heic")).toBe("users/U1/display/2026/11/P1.jpg");
    expect(photoKey("U1", "original", "P1", "2026-11-01T00:30:00+01:00", "image/heic")).toBe("users/U1/originals/2026/11/P1.heic");
  });
});

describe("ulid", () => {
  it("makes valid, time-sortable ids", () => {
    const a = ulid(1_700_000_000_000), b = ulid(1_700_000_000_001);
    expect(isUlid(a) && isUlid(b)).toBe(true);
    expect(a < b).toBe(true);
    expect(isUlid("01M55F00000000000000MEAL1")).toBe(false); // L isn't in the alphabet, and it's 25 chars
  });
});
