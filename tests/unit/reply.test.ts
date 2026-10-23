import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractJson, selfReportedModel, validateReply } from "../../src/shared/reply";

const real = readFileSync(new URL("../fixtures/replies/real-2026-10-18.txt", import.meta.url), "utf8");
const batch = { id: "01M584AT8TRFY6EM4EW4ZZ2N9S", keys: ["A", "B"], activeCodes: [] as string[] };
const parse = (t: string) => validateReply(extractJson(t), batch);
const edit = (fn: (r: any) => void) => {
  const r = JSON.parse(real);
  fn(r);
  return JSON.stringify(r);
};

describe("extractJson", () => {
  it("finds the object inside a fenced block with chatter around it", () => {
    const wrapped = "Here you go!\n\n```json\n" + real + "\n```\nLet me know if you need anything else {really}.";
    expect(extractJson(wrapped)).toEqual(JSON.parse(real));
  });
  it("reads the JSON block after a readable copy, even if that copy has braces (prompt/9)", () => {
    const reply = "**A · Sat dinner** {curry night}\nabout 400 kcal\n\n```json\n" + real + "\n```\n";
    expect(extractJson(reply)).toEqual(JSON.parse(real));
    // A correction later in the same paste: the last block wins.
    const corrected = JSON.stringify({ ...JSON.parse(real), model: "fixed" });
    expect((extractJson(reply + "\nFixed:\n```json\n" + corrected + "\n```") as { model: string }).model).toBe("fixed");
  });
  it("isn't fooled by braces inside strings", () => {
    expect(extractJson('x {"a": "} {", "b": {"c": 1}} y')).toEqual({ a: "} {", b: { c: 1 } });
  });
  it("explains what's wrong with broken input", () => {
    expect(() => extractJson("no json here")).toThrow("No JSON object");
    expect(() => extractJson(real.slice(0, 200))).toThrow("incomplete");
    expect(() => extractJson('{"a": 1,}')).toThrow("doesn't parse");
  });
});

describe("validateReply", () => {
  it("accepts the first real reply", () => {
    const { reply, errors } = parse(real);
    expect(errors).toEqual([]);
    expect(reply!.meals.map((m) => [m.key, m.kcal, m.confidence])).toEqual([["A", 400, "low"], ["B", 460, "medium"]]);
    expect(reply!.summary.suggestion).toContain("lassi");
  });
  it("rejects a reply for another batch, or with missing, extra or repeated meals", () => {
    expect(parse(edit((r) => (r.batch_id = "01OTHER"))).errors[0]).toContain("wrong batch");
    expect(parse(edit((r) => r.meals.pop())).errors).toContain("The reply is missing meal B.");
    expect(parse(edit((r) => r.meals.push({ ...r.meals[0], key: "C" }))).errors).toContain("Meal C isn't in this batch (its keys are A, B).");
    expect(parse(edit((r) => (r.meals[1].key = "A"))).errors).toContain("Meal A appears more than once.");
  });
  it("rejects bad numbers and confidences, but accepts numerals written as strings", () => {
    expect(parse(edit((r) => (r.meals[0].kcal = -5))).errors[0]).toContain("Meal A kcal must be a number");
    expect(parse(edit((r) => (r.meals[0].confidence = "very"))).errors[0]).toContain("confidence");
    expect(parse(edit((r) => (r.meals[0].kcal = "400"))).reply!.meals[0].kcal).toBe(400);
  });
  it("lets a skipped meal go without a description", () => {
    const { reply, errors } = parse(edit((r) => Object.assign(r.meals[1], { skipped: true, skip_reason: "blurry", description: null, kcal: null })));
    expect(errors).toEqual([]);
    expect(reply!.meals[1].skipped).toBe(true);
  });
  it("checks remembered-food changes against the codes the prompt listed", () => {
    const add = { action: "add", code: null, name: "usual lassi shake", serving: "16 oz", kcal: 460, protein_g: 32, carbs_g: 65, fat_g: 8, reason: "x" };
    expect(parse(edit((r) => r.remember.push(add))).errors).toEqual([]);
    expect(parse(edit((r) => r.remember.push({ ...add, code: "F9" }))).errors[0]).toContain("code null");
    expect(parse(edit((r) => r.remember.push({ ...add, action: "retire", code: "F1" }))).errors[0]).toContain("retire needs one of");
    expect(parse(edit((r) => (r.meals[0].foods_used = ["F2"]))).errors[0]).toContain("cites F2");
    const withF1 = validateReply(JSON.parse(edit((r) => { r.meals[0].foods_used = ["F1"]; r.remember.push({ ...add, action: "update", code: "F1" }); })), { ...batch, activeCodes: ["F1"] });
    expect(withF1.errors).toEqual([]);
  });
});

describe("fiber (prompt/7)", () => {
  it("reads fiber on meals and remembered foods, and treats a reply without it as unknown", () => {
    expect(parse(real).reply!.meals[0].fiber_g).toBeNull(); // the first real reply predates prompt/7
    const add = { action: "add", code: null, name: "usual lassi shake", serving: "16 oz", kcal: 460, protein_g: 32, carbs_g: 65, fat_g: 8, fiber_g: 6, reason: "x" };
    const { reply } = parse(edit((r) => { r.meals[0].fiber_g = 7.5; r.remember.push(add); }));
    expect(reply!.meals[0].fiber_g).toBe(7.5);
    expect(reply!.remember[0].fiber_g).toBe(6);
    expect(parse(edit((r) => (r.meals[0].fiber_g = "lots"))).errors[0]).toContain("Meal A fiber_g must be a number");
  });
});

describe("selfReportedModel (prompt/3)", () => {
  it("reads the model's claim about itself, and ignores unusable values", () => {
    expect(selfReportedModel({ model: "  claude-opus-5-5  " })).toBe("claude-opus-5-5");
    expect(selfReportedModel({ model: null })).toBeNull();
    expect(selfReportedModel({})).toBeNull(); // the first real reply predates prompt/3
    expect(selfReportedModel({ model: "<your model name and version, as you know it, or null>" })).toBeNull(); // template echoed back
    expect(selfReportedModel({ model: "x".repeat(81) })).toBeNull();
  });
  it("is carried on the validated reply", () => {
    expect(parse(edit((r) => (r.model = "claude-opus-5-5"))).reply!.model).toBe("claude-opus-5-5");
    expect(parse(real).reply!.model).toBeNull();
  });
});

describe("asked questions (prompt/4)", () => {
  it("keeps what was asked and answered, forgiving about form", () => {
    const { reply, errors } = parse(edit((r) => (r.asked = [
      { topic: "curry protein", question: "Chicken or paneer?", answer: "paneer" },
      { question: "Any honey in the shake?", answer: "" },
      { topic: "junk" },
      "not an object",
    ])));
    expect(errors).toEqual([]);
    expect(reply!.asked).toEqual([
      { topic: "curry protein", question: "Chicken or paneer?", answer: "paneer" },
      { topic: "Any honey in the shake?", question: "Any honey in the shake?", answer: null },
    ]);
  });
  it("treats a missing or malformed list as no questions, and keeps at most 5", () => {
    expect(parse(real).reply!.asked).toEqual([]);
    expect(parse(edit((r) => (r.asked = "none"))).reply!.asked).toEqual([]);
    const echoed = { topic: "<short topic>", question: "<the question you asked>", answer: "<my answer, or null>" };
    expect(parse(edit((r) => (r.asked = [echoed]))).reply!.asked).toEqual([]);
    const many = Array.from({ length: 8 }, (_, i) => ({ topic: `t${i}`, question: `q${i}?`, answer: "a" }));
    expect(parse(edit((r) => (r.asked = many))).reply!.asked).toHaveLength(5);
  });
});
