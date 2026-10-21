import { describe, expect, it } from "vitest";
import { DRAFT_IDLE_MS, isStaleDraft } from "../../src/app/lib/drafts";
import type { OutboxMeal } from "../../src/app/lib/outbox";

const now = Date.parse("2026-10-21T21:00:00Z");
const draft = (createdAgoMin: number, photoAgoMin: (number | undefined)[]): OutboxMeal => ({
  id: "D", userId: "U", takenAt: "2026-10-21T15:00:00-05:00", tz: "America/Chicago", mealType: "dinner", note: null, draft: true,
  createdAt: new Date(now - createdAgoMin * 60_000).toISOString(),
  photos: photoAgoMin.map((ago, i) => ({
    id: `P${i}`, position: i, original: new Blob(), mime: "image/jpeg", sha256: "", display: new Blob(), displaySha256: "",
    width: 1, height: 1, uploaded: { original: false, display: false },
    addedAt: ago === undefined ? undefined : now - ago * 60_000,
  })),
});

describe("isStaleDraft", () => {
  it("keeps a meal in progress open: the last helping was under 90 minutes ago", () => {
    expect(DRAFT_IDLE_MS).toBe(90 * 60_000);
    expect(isStaleDraft(draft(150, [150, 100, 60]), now)).toBe(false); // started 2.5 h ago, still eating
  });
  it("saves one left open: nothing added for over 90 minutes", () => {
    expect(isStaleDraft(draft(200, [200, 120, 95]), now)).toBe(true);
  });
  it("falls back to when the draft began for photos from older builds", () => {
    expect(isStaleDraft(draft(30, [undefined]), now)).toBe(false);
    expect(isStaleDraft(draft(120, [undefined]), now)).toBe(true);
  });
  it("never saves an empty draft", () => {
    expect(isStaleDraft(draft(500, []), now)).toBe(false);
  });
});
