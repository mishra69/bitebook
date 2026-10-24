import { describe, expect, it } from "vitest";
import { buildPrompt } from "../../src/shared/prompt";
import { REPLY_JSON_SCHEMA, validateReply } from "../../src/shared/reply";
import { checkImageLink, imageLink } from "../../src/worker/analyze";

const base = {
  batchId: "01B", notes: [], foods: [], digest: [], asked: [], trend: { days: 0, kcal: null, protein_g: null, fiber_g: null },
  meals: [{ key: "A", taken_at: "2026-10-24T13:00:00-05:00", meal_type: "lunch" as const, note: null, photos: [{ position: 0, taken_at: "2026-10-24T13:00:00-05:00" }] }],
};

describe("the API variant of the prompt (prompt/10)", () => {
  it("puts questions in the reply instead of the chat, and asks for the JSON alone", () => {
    const p = buildPrompt({ ...base, channel: "api" });
    expect(p).toContain("I'm not here to answer questions before you reply");
    expect(p).toContain("Reply with ONLY the JSON object");
    expect(p).toContain('"question": "<a question for me>"');
    expect(p).not.toContain('"asked"');
    expect(p).not.toContain("readable copy");
    expect(buildPrompt(base)).toContain("then wait for my answers before writing the JSON"); // chat unchanged
  });
  it("carries the earlier estimate and what the user said, for a revision", () => {
    const p = buildPrompt({ ...base, channel: "api", revision: { key: "A", previous: { description: "dal", kcal: 400 }, input: "My correction: it was two bowls" } });
    expect(p).toContain('## Revising meal A\nYou estimated this meal before. Your earlier estimate:\n{"description":"dal","kcal":400}');
    expect(p).toContain("My correction: it was two bowls");
  });
});

describe("the API reply", () => {
  const reply = (questions: unknown) => ({
    schema: "bitebook.reply/1", batch_id: "01B", model: null,
    meals: [{ key: "A", skipped: false, skip_reason: null, description: "dal", kcal: 400, protein_g: 20, carbs_g: 50, fat_g: 10, fiber_g: 8, confidence: "medium", foods_used: [], comment: null }],
    remember: [], questions, summary: { text: "ok", suggestion: null },
  });
  it("keeps up to two open questions, forgiving about form", () => {
    const { reply: r, errors } = validateReply(
      reply([{ topic: "portion", question: "Full plate or half?" }, { question: "Ghee on the roti?" }, { question: "A third?" }, "junk"]),
      { id: "01B", keys: ["A"], activeCodes: [] },
    );
    expect(errors).toEqual([]);
    expect(r!.questions).toEqual([
      { topic: "portion", question: "Full plate or half?" },
      { topic: "Ghee on the roti?", question: "Ghee on the roti?" },
    ]);
  });
  it("has a strict JSON schema: every property required, no extras", () => {
    const check = (s: any) => {
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect(s.required.sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(check);
      }
      if (s.type === "array") check(s.items);
    };
    check(REPLY_JSON_SCHEMA);
  });
});

describe("signed photo links for the model provider", () => {
  const env = { SESSION_SECRET: "test-secret" } as any;
  const photo = "01M5KCYQ41B5HRM6C2HSJ37BDG";
  it("verify for 30 minutes, and not when tampered with or for another photo", async () => {
    const now = Date.parse("2026-10-24T12:00:00Z");
    const [, , exp, sig] = new URL(await imageLink(env, "https://x.test", photo, now)).pathname.split("/").slice(1);
    expect(await checkImageLink(env, photo, exp, sig, now)).toBe(true);
    expect(await checkImageLink(env, photo, exp, sig, now + 31 * 60_000)).toBe(false);
    expect(await checkImageLink(env, "01M5KE9HVTSBFS1H95R6HBAFXS", exp, sig, now)).toBe(false);
    expect(await checkImageLink(env, photo, String(Number(exp) + 1), sig, now)).toBe(false);
    expect(await checkImageLink({ SESSION_SECRET: "other" } as any, photo, exp, sig, now)).toBe(false);
  });
});
