// The prompt handed to a model for a batch (docs/SPEC.md §6, prompt/1). This file is the
// authoritative template: change it only together with PROMPT_VERSION, because every
// stored batch records the version its prompt was built with.
import type { MealType } from "./meals";

// prompt/2 (2026-10-18): suggestions point to Bitebook notes, since a model can't save them.
// prompt/3 (2026-10-18): the reply names the model that wrote it, as far as it knows (D17).
// prompt/4 (2026-10-18): up to 2 questions in the chat before the JSON, never repeated (D18).
// prompt/5 (2026-10-21): each photo's own time, and helpings counted separately (D19).
// prompt/6 (2026-10-21): a meal's voice note, as transcribed text (D21).
// prompt/7 (2026-10-23): fiber, per meal and per remembered food (D22).
export const PROMPT_VERSION = "prompt/7";
export const MAX_QUESTIONS = 2;
export const ASKED_MAX_LINES = 60;
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
  fiber_g: number | null;
};

export type DigestEntry = {
  taken_at: string; // local time with offset
  meal_type: MealType | null;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  foods_used: string[];
};

export type Trend = { days: number; kcal: number | null; protein_g: number | null; fiber_g: number | null };

export type AskedQuestion = { topic: string; question: string; answer: string | null; asked_at: string };

export type PromptMeal = {
  key: string;
  taken_at: string;
  meal_type: MealType | null;
  note: string | null;
  photos: { position: number; taken_at: string }[];
  voice?: { transcript: string | null } | null; // null transcript: recorded but not transcribed
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
// Fiber came in with prompt/7; older estimates simply don't have it.
const fiber = (n: number | null) => (n === null ? "" : ` fiber ${num(n)}`);

export function foodLine(f: RememberedFood): string {
  return `[${f.code}] ${f.name} · ${f.serving} · ${num(f.kcal)} kcal · P${num(f.protein_g)} C${num(f.carbs_g)} F${num(f.fat_g)}${fiber(f.fiber_g)}`;
}

export function digestLine(e: DigestEntry): string {
  const d = e.taken_at;
  const codes = e.foods_used.length ? ` [${e.foods_used.join(", ")}]` : "";
  return (
    `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)} ${weekday(d)} ${d.slice(11, 16)} ${e.meal_type ?? "meal"}` +
    ` · ${e.description} · ~${num(e.kcal)} kcal · P${num(e.protein_g)} C${num(e.carbs_g)} F${num(e.fat_g)}${fiber(e.fiber_g)}${codes}`
  );
}

// Averages over the days that have analyzed meals, in the last 7 days before `now`.
export function computeTrend(entries: DigestEntry[], now: number): Trend {
  const recent = entries.filter((e) => now - Date.parse(e.taken_at) < 7 * 86_400_000);
  const days = new Set(recent.map((e) => e.taken_at.slice(0, 10))).size;
  if (days === 0) return { days: 0, kcal: null, protein_g: null, fiber_g: null };
  const sum = (k: "kcal" | "protein_g") => recent.reduce((s, e) => s + (e[k] ?? 0), 0);
  // Fiber averages only over days whose meals all have it, so estimates from before
  // prompt/7 don't drag it down.
  const fiberDays = new Map<string, number | null>();
  for (const e of recent) {
    const d = e.taken_at.slice(0, 10);
    const sofar = fiberDays.has(d) ? fiberDays.get(d)! : 0;
    fiberDays.set(d, sofar === null || e.fiber_g === null ? null : sofar + e.fiber_g);
  }
  const fiberTotals = [...fiberDays.values()].filter((v): v is number => v !== null);
  return {
    days,
    kcal: Math.round(sum("kcal") / days),
    protein_g: Math.round(sum("protein_g") / days),
    fiber_g: fiberTotals.length ? Math.round(fiberTotals.reduce((a, b) => a + b, 0) / fiberTotals.length) : null,
  };
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
      fiber_g: 9,
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
      fiber_g: 6,
      reason: "Same dish in 6 of the last 30 days.",
    },
  ],
  // A neutral sample, so it can't be mistaken for a real question already asked.
  asked: [{ topic: "<short topic>", question: "<the question you asked>", answer: "<my answer, or null>" }],
  summary: { text: "…", suggestion: "…" },
};

export type PromptInput = {
  batchId: string;
  notes: string[];
  foods: RememberedFood[];
  digest: DigestEntry[]; // newest first
  trend: Trend;
  asked: AskedQuestion[]; // newest first
  meals: PromptMeal[]; // in key order
};

export function askedLine(q: AskedQuestion): string {
  const d = q.asked_at;
  return `- ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)} · ${q.topic}: ${q.question} → ${q.answer?.trim() || "no answer (use your best guess)"}`;
}

export function buildPrompt(p: PromptInput): string {
  const notes = p.notes.map((n) => n.trim()).filter(Boolean);
  const digest = p.digest.slice(0, DIGEST_MAX_LINES);
  const asked = p.asked.slice(0, ASKED_MAX_LINES);
  const meals = p.meals
    .map((m) => {
      const photos = [...m.photos].sort((a, b) => a.position - b.position);
      const first = Date.parse(photos[0]?.taken_at ?? m.taken_at);
      const files = photos.map((ph) => {
        const later = Math.floor((Date.parse(ph.taken_at) - first) / 60_000);
        return `${photoFileName(m.key, ph.position, ph.taken_at)} (${ph.taken_at.slice(11, 16)}${later >= 1 ? `, +${later} min` : ""})`;
      });
      return (
        `[${m.key}] ${weekday(m.taken_at)} ${m.taken_at.slice(0, 10)} ${m.taken_at.slice(11, 16)} · ${m.meal_type ?? "meal"}` +
        ` · photos: ${files.join(", ")}\nNote: ${m.note?.trim() || "—"}` +
        (m.voice ? `\nVoice note (my words, transcribed): ${m.voice.transcript?.trim() || "(recorded, but it couldn't be transcribed)"}` : "")
      );
    })
    .join("\n");
  const trend = p.trend.days
    ? `Last 7 days: ${p.trend.days} day${p.trend.days === 1 ? "" : "s"} logged · avg ${p.trend.kcal} kcal/day · protein ${p.trend.protein_g} g/day${p.trend.fiber_g === null ? "" : ` · fiber ${p.trend.fiber_g} g/day`}`
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

Questions already asked (don't ask these again; use the answers):
${asked.length ? asked.map(askedLine).join("\n") : "—"}

## New meals (times are my local time)
${meals}

## What to do
0. Questions come first, and usually there are none. Ask only if an answer would change
   an estimate by roughly 100 kcal or more, or would matter for future meals. Ask at most
   ${MAX_QUESTIONS}, together in one message, then wait for my answers before writing the JSON.
   Never ask anything listed under "Questions already asked". If I skip a question or
   don't know, use your best assumption and say so in the comment.
1. For each meal: describe it in a few words and estimate kcal, protein, carbs, fat and
   fiber (grams) for what was eaten. If a nutrition label or package is visible, use it. When you
   recognize a remembered food, use its values and list its code in foods_used. Stay
   consistent with how similar meals in the last ${DIGEST_DAYS} days were estimated. If a photo is
   unusable, set skipped to true and say why in skip_reason.
   A voice note is me describing the meal in my own words (it may describe each photo):
   trust it over what the photos suggest, but allow for transcription slips in food names.
   A meal's photos can be separate helpings. Photos taken several minutes apart are
   additional servings: count what's on each one, and mention the number of helpings in
   the description. Photos within a minute or so of each other are usually the same
   plate from another angle: don't count it twice.
2. Changes to what I should remember: add a food when you read a label or see the same
   dish recurring in the last ${DIGEST_DAYS} days; update one whose values look off; retire one I
   seem to have stopped eating. "add" has code null; "update" and "retire" use an
   existing code. Only list changes. Most batches need none, so remember is often [].
3. Two or three sentences on this batch, with one practical suggestion. If knowing
   something would make future estimates better (a recipe I make often, my usual
   portion), suggest I add it to my notes in Bitebook: you can't save notes yourself,
   and every future batch sees them.

Set "model" to your own model name and version as you know it, or null if you don't know.
In "asked", list the questions you asked me in this chat with my answers (answer null if I
didn't answer); it's [] when you asked nothing. Every meal key above must appear exactly
once in "meals". Your final reply must be ONLY one JSON code block in exactly this format,
with no other text:
\`\`\`json
${JSON.stringify({ ...REPLY_EXAMPLE, batch_id: p.batchId }, null, 2)}
\`\`\`
`;
}
