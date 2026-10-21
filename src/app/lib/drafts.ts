import type { OutboxMeal } from "./outbox";

// A draft whose last photo was added this long ago is a meal someone forgot to save
// (D19). The app can't run in the background, so this is checked when it opens or returns.
export const DRAFT_IDLE_MS = 90 * 60_000;

export function lastPhotoAddedAt(d: OutboxMeal): number {
  // Drafts from builds before D19 have no addedAt: fall back to when the draft began.
  return Math.max(Date.parse(d.createdAt), ...d.photos.map((p) => p.addedAt ?? 0));
}

export const isStaleDraft = (d: OutboxMeal, now = Date.now()) => d.photos.length > 0 && now - lastPhotoAddedAt(d) > DRAFT_IDLE_MS;
