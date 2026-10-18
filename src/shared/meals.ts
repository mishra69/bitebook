// Shapes shared by the app and the Worker for creating and listing meals.

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export type NewPhoto = {
  id: string;
  position: number;
  mime: string;
  bytes: number;
  sha256: string; // hex, of the original
  display_bytes: number;
  display_sha256: string;
  width: number | null;
  height: number | null;
};

export type NewMeal = {
  id: string;
  taken_at: string; // ISO 8601 with the device's UTC offset
  tz: string; // IANA zone
  meal_type: MealType | null;
  note: string | null;
  photos: NewPhoto[];
};

export type Meal = {
  id: string;
  taken_at: string;
  tz: string;
  meal_type: MealType | null;
  note: string | null;
  photos: { id: string; position: number; width: number | null; height: number | null }[];
};

export type DeletedMeal = {
  id: string;
  taken_at: string;
  meal_type: MealType | null;
  note: string | null;
  deleted_at: string;
  purge_at: string; // when the daily purge removes it for good
  cover_photo_id: string | null;
};

// R2 keys (docs/SPEC.md §5). The month comes from the meal's local taken_at.
export function photoKey(userId: string, kind: "original" | "display", photoId: string, takenAt: string, mime: string) {
  const month = takenAt.slice(0, 4) + "/" + takenAt.slice(5, 7);
  const ext = kind === "display" ? "jpg" : extFor(mime);
  return `users/${userId}/${kind === "original" ? "originals" : "display"}/${month}/${photoId}.${ext}`;
}

function extFor(mime: string) {
  return ({ "image/jpeg": "jpg", "image/heic": "heic", "image/heif": "heif", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[mime] ?? "bin";
}
