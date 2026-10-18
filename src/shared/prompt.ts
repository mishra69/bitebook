// The prompt handed to a model for a batch (docs/SPEC.md §6, prompt/1). This file is the
// authoritative template: change it only together with PROMPT_VERSION, because every
// stored batch records the version its prompt was built with.
import type { MealType } from "./meals";

// prompt/2 (2026-10-18): suggestions point to Bitebook notes, since a model can't save them.
// prompt/3 (2026-10-18): the reply names the model that wrote it, as far as it knows (D17).
export const PROMPT_VERSION = "prompt/3";
export const REPLY_SCHEMA = "bitebook.reply/1";
export const DIGEST_DAYS = 30;
export const DIGEST_MAX_LINES = 150;

export type RememberedFood = {
  code: string;
  name: string;
  serving: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

export type DigestEntry = {
  taken_at: string; // local time with offset
  meal_type: MealType | null;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  foods_used: string[];
};

export type Trend = { days: number; kcal: number | null; protein_g: number | null };

export type PromptMeal = {
  key: string;
  taken_at: string;
  meal_type: MealType | null;
  note: string | null;
  photos: { position: number }[];
};

// A, B, …, Z, AA, AB, …: short keys a model is unlikely to garble.
export function batchKey(i: number): string {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// e.g. B-2_2026-10-16_1932.jpg: self-describing even if attachments arrive out of order.
export function photoFileName(key: string, position: number, takenAt: string): string {
  return `${key}-${position + 1}_${takenAt.slice(0, 10)}_${takenAt.slice(11, 13)}${takenAt.slice(14, 16)}.jpg`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// The weekday of the local calendar date in taken_at (independent of the server's zone).
const weekday = (iso: string) => WEEKDAYS[new Date(iso.slice(0, 10) + "T12:00:00Z").getUTCDay()];
const num = (n: number | null) => (n === null ? "?" : String(Math.round(n * 10) / 10));

export function foodLine(f: RememberedFood): string {
  return `[${f.code}] ${f.name} · ${f.serving} · ${num(f.kcal)} kcal · P${num(f.protein_g)} C${num(f.carbs_g)} F${num(f.fat_g)}`;
}

export function digestLine(e: DigestEntry): string {
  const d = e.taken_at;
  const codes = e.foods_used.length ? ` [${e.foods_used.join(", ")}]` : "";
  return (
    `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)} ${weekday(d)} ${d.slice(11, 16)} ${e.meal_type ?? "meal"}` +
    ` · ${e.description} · ~${num(e.kcal)} kcal · P${num(e.protein_g)} C${num(e.carbs_g)} F${num(e.fat_g)}${codes}`
  );
}

// Averages over the days that have analyzed meals, in the last 7 days before `now`.
export function computeTrend(entries: DigestEntry[], now: number): Trend {
  const recent = entries.filter((e) => now - Date.parse(e.taken_at) < 7 * 86_400_000);
  const days = new Set(recent.map((e) => e.taken_at.slice(0, 10))).size;
  if (days === 0) return { days: 0, kcal: null, protein_g: null };
  const sum = (k: "kcal" | "protein_g") => recent.reduce((s, e) => s + (e[k] ?? 0), 0);
  return { days, kcal: Math.round(sum("kcal") / days), protein_g: Math.round(sum("protein_g") / days) };
}

export const REPLY_EXAMPLE = {
  schema: REPLY_SCHEMA,
  batch_id: "<the batch id above>",
  model: "<your model name and version, as you know it, or null>",
  meals: [
    {
      key: "A",
      skipped: false,
      skip_reason: null,
      description: "dal tadka with 2 tortillas",
      kcal: 540,
      protein_g: 22,
      carbs_g: 70,
      fat_g: 16,
      confidence: "medium",
      foods_used: ["F1"],
      comment: "Looks like about 1 tsp ghee on the dal.",
    },
  ],
  remember: [
    {
      action: "add",
      code: null,
      name: "usual dal tadka",
      serving: "1 bowl",
      kcal: 280,
      protein_g: 14,
      carbs_g: 36,
      fat_g: 9,
      reason: "Same dish in 6 of the last 30 days.",
    },
  ],
  summary: { text: "…", suggestion: "…" },
};

export type PromptInput = {
  batchId: string;
  notes: string[];
  foods: RememberedFood[];
  digest: DigestEntry[]; // newest first
  trend: Trend;
  meals: PromptMeal[]; // in key order
};

export function buildPrompt(p: PromptInput): string {
  const notes = p.notes.map((n) => n.trim()).filter(Boolean);
  const digest = p.digest.slice(0, DIGEST_MAX_LINES);
  const meals = p.meals
    .map((m) => {
      const files = [...m.photos].sort((a, b) => a.position - b.position).map((ph) => photoFileName(m.key, ph.position, m.taken_at));
      return (
        `[${m.key}] ${weekday(m.taken_at)} ${m.taken_at.slice(0, 10)} ${m.taken_at.slice(11, 16)} · ${m.meal_type ?? "meal"}` +
        ` · photos: ${files.join(", ")}\nNote: ${m.note?.trim() || "—"}`
      );
    })
    .join("\n");
  const trend = p.trend.days
    ? `Last 7 days: ${p.trend.days} day${p.trend.days === 1 ? "" : "s"} logged · avg ${p.trend.kcal} kcal/day · protein ${p.trend.protein_g} g/day`
    : "Last 7 days: nothing analyzed yet";

  return `You are helping me keep an approximate food log from photos. Rough, consistent
estimates are the goal; precision isn't. Batch: ${p.batchId}

## What you know about me (from my app)
Notes: ${notes.length ? notes.join("\n") : "—"}

Remembered foods (codes stay the same across batches):
${p.foods.length ? p.foods.map(foodLine).join("\n") : "—"}

Last ${DIGEST_DAYS} days, one line per analyzed meal, newest first:
${digest.length ? digest.map(digestLine).join("\n") : "—"}

${trend}

## New meals (times are my local time)
${meals}

## What to do
1. For each meal: describe it in a few words and estimate kcal, protein, carbs and fat
   for what was eaten. If a nutrition label or package is visible, use it. When you
   recognize a remembered food, use its values and list its code in foods_used. Stay
   consistent with how similar meals in the last ${DIGEST_DAYS} days were estimated. If a photo is
   unusable, set skipped to true and say why in skip_reason.
2. Changes to what I should remember: add a food when you read a label or see the same
   dish recurring in the last ${DIGEST_DAYS} days; update one whose values look off; retire one I
   seem to have stopped eating. "add" has code null; "update" and "retire" use an
   existing code. Only list changes. Most batches need none, so remember is often [].
3. Two or three sentences on this batch, with one practical suggestion. If knowing
   something would make future estimates better (a recipe I make often, my usual
   portion), suggest I add it to my notes in Bitebook: you can't save notes yourself,
   and every future batch sees them.

Set "model" to your own model name and version as you know it, or null if you don't know.
Every meal key above must appear exactly once in "meals". Reply with ONLY one JSON code
block in exactly this format, with no other text:
\`\`\`json
${JSON.stringify({ ...REPLY_EXAMPLE, batch_id: p.batchId }, null, 2)}
\`\`\`
`;
}
