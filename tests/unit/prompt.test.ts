import { describe, expect, it } from "vitest";
import { batchKey, buildPrompt, computeTrend, digestLine, photoFileName, type DigestEntry } from "../../src/shared/prompt";

const entry = (taken_at: string, kcal: number, protein_g: number, extra: Partial<DigestEntry> = {}): DigestEntry => ({
  taken_at, meal_type: "dinner", description: "dal tadka with 2 rotis", kcal, protein_g, carbs_g: 75, fat_g: 18, fiber_g: null, foods_used: [], ...extra,
});

describe("batch keys and file names", () => {
  it("counts A…Z then AA, AB…", () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(batchKey)).toEqual(["A", "B", "Z", "AA", "AB", "AZ", "BA"]);
  });
  it("names photos by key, position and local time", () => {
    expect(photoFileName("B", 1, "2026-10-16T19:32:05-05:00")).toBe("B-2_2026-10-16_1932.jpg");
  });
});

describe("digest and trend", () => {
  it("writes one compact line per meal, with the local weekday", () => {
    expect(digestLine(entry("2026-10-16T19:30:00+05:30", 552.4, 20, { foods_used: ["F1", "F3"] }))).toBe(
      "Oct 16 Fri 19:30 dinner · dal tadka with 2 rotis · ~552.4 kcal · P20 C75 F18 [F1, F3]",
    );
  });
  it("averages over logged days in the last 7 days only", () => {
    const now = Date.parse("2026-10-18T12:00:00Z");
    const t = computeTrend(
      [entry("2026-10-17T19:00:00-05:00", 600, 30), entry("2026-10-17T08:00:00-05:00", 400, 20), entry("2026-10-16T13:00:00-05:00", 500, 25), entry("2026-10-01T13:00:00-05:00", 9999, 99)],
      now,
    );
    expect(t).toEqual({ days: 2, kcal: 750, protein_g: 38, fiber_g: null });
    expect(computeTrend([], now)).toEqual({ days: 0, kcal: null, protein_g: null, fiber_g: null });
  });
});

describe("buildPrompt", () => {
  const base = {
    batchId: "01BATCH",
    notes: [],
    foods: [],
    digest: [],
    trend: { days: 0, kcal: null, protein_g: null, fiber_g: null },
    asked: [],
    meals: [
      {
        key: "A", taken_at: "2026-10-16T19:32:05-05:00", meal_type: "dinner" as const, note: null,
        photos: [
          { position: 2, taken_at: "2026-10-16T19:48:40-05:00" }, // a second helping
          { position: 0, taken_at: "2026-10-16T19:32:05-05:00" },
          { position: 1, taken_at: "2026-10-16T19:32:35-05:00" }, // same plate, another angle
        ],
      },
    ],
  };
  it("shows empty memory as dashes, lists meals with their photo files, and asks for the reply format", () => {
    const p = buildPrompt(base);
    expect(p).toContain("Batch: 01BATCH");
    expect(p).toContain("Notes: —");
    expect(p).toContain("Remembered foods (codes stay the same across batches):\n—");
    expect(p).toContain("Last 7 days: nothing analyzed yet");
    expect(p).toContain(
      "[A] Fri 2026-10-16 19:32 · dinner · photos: A-1_2026-10-16_1932.jpg (19:32), A-2_2026-10-16_1932.jpg (19:32), A-3_2026-10-16_1948.jpg (19:48, +16 min)\nNote: —",
    );
    expect(p).toContain("Photos taken several minutes apart are\n   additional servings");
    expect(p).toContain('"schema": "bitebook.reply/1"');
    expect(p).toContain('"batch_id": "01BATCH"');
    expect(p).toContain("suggest I add it to my notes in Bitebook");
    expect(p).toContain('Set "model" to your own model name and version');
    expect(p).toContain('"model": "<your model name and version, as you know it, or null>"');
    expect(p).toContain("Questions already asked (don't ask these again; use the answers):\n—");
    expect(p).toContain("Ask at most\n   2, together in one message, then wait for my answers before writing the JSON.");
    expect(p).toContain("Your final reply must be ONLY one JSON code block");
    expect(p).toContain('"topic": "<short topic>"');
  });
  it("includes notes, remembered foods, the digest (capped) and the trend", () => {
    const digest = Array.from({ length: 200 }, (_, i) => entry(`2026-10-${String(1 + (i % 15)).padStart(2, "0")}T12:00:00-05:00`, 500, 20));
    const p = buildPrompt({
      ...base,
      notes: ["  My usual bowl is 400 ml.  ", ""],
      foods: [{ code: "F1", name: "Mission whole wheat tortilla", serving: "1 tortilla (45 g)", kcal: 130, protein_g: 4, carbs_g: 22, fat_g: 3.5, fiber_g: null }],
      digest,
      trend: { days: 3, kcal: 1800, protein_g: 70, fiber_g: null },
    });
    expect(p).toContain("Notes: My usual bowl is 400 ml.\n");
    expect(p).toContain("[F1] Mission whole wheat tortilla · 1 tortilla (45 g) · 130 kcal · P4 C22 F3.5");
    expect(p.match(/· dal tadka with 2 rotis ·/g)).toHaveLength(150);
    expect(p).toContain("Last 7 days: 3 days logged · avg 1800 kcal/day · protein 70 g/day");
  });
});

describe("questions already asked (prompt/4)", () => {
  it("lists them newest first, with answers or a best-guess note", () => {
    const p = buildPrompt({
      batchId: "01B", notes: [], foods: [], digest: [], trend: { days: 0, kcal: null, protein_g: null, fiber_g: null }, meals: [],
      asked: [
        { topic: "curry protein", question: "Chicken or paneer in the curry?", answer: "paneer", asked_at: "2026-10-18T19:00:00.000Z" },
        { topic: "shake sweetener", question: "Any honey in the shake?", answer: null, asked_at: "2026-10-16T19:00:00.000Z" },
      ],
    });
    expect(p).toContain(
      "- Oct 18 · curry protein: Chicken or paneer in the curry? → paneer\n- Oct 16 · shake sweetener: Any honey in the shake? → no answer (use your best guess)",
    );
  });
});

describe("voice notes (prompt/6)", () => {
  const meal = (voice: { transcript: string | null } | null) => ({
    key: "A", taken_at: "2026-10-21T19:30:00-05:00", meal_type: "dinner" as const, note: null,
    photos: [{ position: 0, taken_at: "2026-10-21T19:30:00-05:00" }], voice,
  });
  const build = (voice: { transcript: string | null } | null) =>
    buildPrompt({ batchId: "01B", notes: [], foods: [], digest: [], asked: [], trend: { days: 0, kcal: null, protein_g: null, fiber_g: null }, meals: [meal(voice)] });

  it("adds the transcript under the meal's note, and says how to weigh it", () => {
    const p = build({ transcript: "  First plate was dal and two rotis, second plate just rice.  " });
    expect(p).toContain("Note: —\nVoice note (my words, transcribed): First plate was dal and two rotis, second plate just rice.\n");
    expect(p).toContain("trust it over what the photos suggest");
  });
  it("says so when a recording couldn't be transcribed, and adds nothing without one", () => {
    expect(build({ transcript: null })).toContain("Voice note (my words, transcribed): (recorded, but it couldn't be transcribed)");
    expect(build(null)).not.toContain("Voice note (my words");
  });
});

describe("fiber (prompt/7)", () => {
  it("shows fiber in digest and food lines when known, and leaves it out for older estimates", () => {
    expect(digestLine(entry("2026-10-16T19:30:00+05:30", 550, 20, { fiber_g: 9.5 }))).toBe(
      "Oct 16 Fri 19:30 dinner · dal tadka with 2 rotis · ~550 kcal · P20 C75 F18 fiber 9.5",
    );
    const p = buildPrompt({
      batchId: "01B", notes: [], digest: [], asked: [], meals: [],
      foods: [{ code: "F1", name: "lassi shake", serving: "16 oz", kcal: 460, protein_g: 32, carbs_g: 65, fat_g: 8, fiber_g: 6 }],
      trend: { days: 2, kcal: 1800, protein_g: 70, fiber_g: 24 },
    });
    expect(p).toContain("[F1] lassi shake · 16 oz · 460 kcal · P32 C65 F8 fiber 6");
    expect(p).toContain("protein 70 g/day · fiber 24 g/day");
    expect(p).toContain("estimate kcal, protein, carbs, fat and\n   fiber (grams)");
    expect(p).toContain('"fiber_g": 9');
  });
  it("averages fiber only over days where every meal has it", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const t = computeTrend(
      [
        entry("2026-10-22T19:00:00-05:00", 600, 30, { fiber_g: 12 }),
        entry("2026-10-22T08:00:00-05:00", 400, 20, { fiber_g: 8 }),
        entry("2026-10-21T13:00:00-05:00", 500, 25, { fiber_g: 10 }),
        entry("2026-10-21T08:00:00-05:00", 300, 15), // before prompt/7: that day is left out
      ],
      now,
    );
    expect(t.fiber_g).toBe(20);
  });
});

describe("meals without a photo (prompt/8)", () => {
  it("marks the meal and its approximate time, and says how to estimate it", () => {
    const p = buildPrompt({
      batchId: "01B", notes: [], foods: [], digest: [], asked: [], trend: { days: 0, kcal: null, protein_g: null, fiber_g: null },
      meals: [{ key: "A", taken_at: "2026-10-22T13:00:00-05:00", meal_type: "lunch", note: null, photos: [], voice: { transcript: "two rotis and dal" } }],
    });
    expect(p).toContain("[A] Thu 2026-10-22 ~13:00 · lunch · no photo (added afterwards from my description)\nNote: —\nVoice note (my words, transcribed): two rotis and dal");
    expect(p).toContain("A meal with no photo is one I forgot to photograph");
  });
});
