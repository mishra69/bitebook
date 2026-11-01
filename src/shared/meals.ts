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
  taken_at?: string; // this photo's own time; missing from builds before D19 (the meal's time is used)
};

export type NewMeal = {
  id: string;
  taken_at: string; // ISO 8601 with the device's UTC offset
  tz: string; // IANA zone
  meal_type: MealType | null;
  note: string | null;
  photos: NewPhoto[]; // empty for a meal added afterwards from a description (D24)
  voices?: NewVoice[]; // uploaded beforehand, like the photos, in the order recorded (D46)
  voice?: Omit<NewVoice, "id" | "recorded_at">; // before D46: one note, filed under the meal's id
};

// Spoken notes for the meal (D21): up to MAX_VOICES (D46), each at most MAX_VOICE_MS long.
export const MAX_VOICE_MS = 60_000;
export const MAX_VOICES = 5;
export type NewVoice = { id: string; mime: string; bytes: number; sha256: string; duration_ms: number; recorded_at?: string };
export type VoiceNote = { id: string; duration_ms: number; recorded_at: string | null; transcript: string | null; transcript_model: string | null };

export type Meal = {
  id: string;
  taken_at: string;
  tz: string;
  meal_type: MealType | null;
  note: string | null;
  photos: { id: string; position: number; width: number | null; height: number | null; taken_at: string }[];
  voices?: VoiceNote[]; // on the detail screen, in the order recorded
  has_voice?: boolean; // whether there's a voice note (in lists; its text is on the detail screen)
  analysis?: Analysis | null; // the latest non-skipped one, in lists
  analyses?: Analysis[]; // every one, newest first, on the detail screen
  api?: ApiState; // the API path's latest run and open questions (D28)
};

export type ApiState = {
  job: { status: "queued" | "running" | "done" | "failed"; kind: "analyze" | "revise"; error: string | null } | null;
  questions: { id: string; topic: string; question: string }[];
};

export type Analysis = {
  id: string;
  created_at: string;
  model: string;
  skipped: boolean;
  skip_reason: string | null;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null; // only from prompt/7 on
  confidence: "low" | "medium" | "high" | null;
  comment: string | null;
  foods_used: string[];
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

// A voice note's file is named by its own id; a note from before D46 has its meal's id.
export function voiceKey(userId: string, voiceId: string, takenAt: string, mime: string) {
  const month = takenAt.slice(0, 4) + "/" + takenAt.slice(5, 7);
  const ext = mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac") ? "m4a" : mime.includes("webm") ? "webm" : mime.includes("ogg") ? "ogg" : "bin";
  return `users/${userId}/voice/${month}/${voiceId}.${ext}`;
}

function extFor(mime: string) {
  return ({ "image/jpeg": "jpg", "image/heic": "heic", "image/heif": "heif", "image/png": "png", "image/webp": "webp" } as Record<string, string>)[mime] ?? "bin";
}
