// Parsing and validating a pasted (or API) reply (docs/SPEC.md §6, bitebook.reply/1). This
// file is authoritative for the reply contract. Validation is all-or-nothing: any error
// means nothing is stored.
import { REPLY_SCHEMA } from "./prompt";

export const CONFIDENCES = ["low", "medium", "high"] as const;

export type MealResult = {
  key: string;
  skipped: boolean;
  skip_reason: string | null;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  confidence: (typeof CONFIDENCES)[number] | null;
  foods_used: string[];
  comment: string | null;
};

export type RememberChange = {
  action: "add" | "update" | "retire";
  code: string | null;
  name: string;
  serving: string;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  reason: string | null;
};

export type Reply = {
  schema: string;
  batch_id: string;
  meals: MealResult[];
  remember: RememberChange[];
  summary: { text: string; suggestion: string | null };
};

export type BatchFacts = { id: string; keys: string[]; activeCodes: string[] };

// Chat apps wrap JSON in ```json fences and sometimes add a sentence around it. Take
// the first balanced {...} object, respecting strings so braces inside them don't count.
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in the pasted text.");
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch (e) {
        throw new Error(`The JSON doesn't parse: ${(e as Error).message}`);
      }
    }
  }
  throw new Error("The JSON object is incomplete. Was the reply cut off?");
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : null);

export function validateReply(raw: unknown, batch: BatchFacts): { reply: Reply | null; errors: string[] } {
  const errors: string[] = [];
  const err = (m: string) => void errors.push(m);
  if (!isObj(raw)) return { reply: null, errors: ["The reply isn't a JSON object."] };

  if (raw.schema !== REPLY_SCHEMA) err(`"schema" must be "${REPLY_SCHEMA}" (got ${JSON.stringify(raw.schema)}).`);
  if (raw.batch_id !== batch.id) err(`This reply is for batch ${JSON.stringify(raw.batch_id)}, not ${batch.id}. Was it pasted into the wrong batch?`);

  // Numbers: ≥ 0 or null. Models sometimes write "400" as a string; accept plain numerals.
  const num = (v: unknown, where: string): number | null => {
    if (v === null || v === undefined) return null;
    const n = typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      err(`${where} must be a number ≥ 0 or null (got ${JSON.stringify(v)}).`);
      return null;
    }
    return n;
  };
  const codes = (v: unknown, where: string): string[] => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every((c) => typeof c === "string")) {
      err(`${where} must be a list of codes like ["F1"].`);
      return [];
    }
    for (const c of v) if (!batch.activeCodes.includes(c)) err(`${where} cites ${c}, which this batch's prompt didn't list.`);
    return v as string[];
  };

  const meals: MealResult[] = [];
  if (!Array.isArray(raw.meals)) err(`"meals" must be a list.`);
  else {
    const seen = new Set<string>();
    for (const [i, m] of raw.meals.entries()) {
      if (!isObj(m) || typeof m.key !== "string") {
        err(`meals[${i}] needs a "key".`);
        continue;
      }
      const at = `Meal ${m.key}`;
      if (seen.has(m.key)) err(`${at} appears more than once.`);
      seen.add(m.key);
      if (!batch.keys.includes(m.key)) err(`${at} isn't in this batch (its keys are ${batch.keys.join(", ")}).`);
      const skipped = m.skipped === true;
      const description = str(m.description);
      if (!skipped && !description) err(`${at} needs a description.`);
      const confidence = m.confidence ?? null;
      if (confidence !== null && !CONFIDENCES.includes(confidence as never)) err(`${at}: confidence must be low, medium or high.`);
      meals.push({
        key: m.key,
        skipped,
        skip_reason: str(m.skip_reason),
        description: description ?? "",
        kcal: num(m.kcal, `${at} kcal`),
        protein_g: num(m.protein_g, `${at} protein_g`),
        carbs_g: num(m.carbs_g, `${at} carbs_g`),
        fat_g: num(m.fat_g, `${at} fat_g`),
        confidence: confidence as MealResult["confidence"],
        foods_used: codes(m.foods_used, `${at} foods_used`),
        comment: str(m.comment),
      });
    }
    const missing = batch.keys.filter((k) => !seen.has(k));
    if (missing.length) err(`The reply is missing meal${missing.length > 1 ? "s" : ""} ${missing.join(", ")}.`);
  }

  const remember: RememberChange[] = [];
  if (raw.remember !== undefined && raw.remember !== null && !Array.isArray(raw.remember)) err(`"remember" must be a list.`);
  for (const [i, r] of (Array.isArray(raw.remember) ? raw.remember : []).entries()) {
    const at = `remember[${i}]`;
    if (!isObj(r) || !["add", "update", "retire"].includes(r.action as string)) {
      err(`${at}: action must be add, update or retire.`);
      continue;
    }
    const action = r.action as RememberChange["action"];
    const code = typeof r.code === "string" ? r.code : null;
    if (action === "add" && code !== null) err(`${at}: "add" must have code null (the app assigns codes).`);
    if (action !== "add" && (code === null || !batch.activeCodes.includes(code))) {
      err(`${at}: ${action} needs one of this batch's codes (${batch.activeCodes.join(", ") || "none"}).`);
    }
    const name = str(r.name) ?? "";
    const serving = str(r.serving) ?? "";
    if (action !== "retire" && (!name || !serving)) err(`${at}: ${action} needs a name and a serving.`);
    remember.push({
      action, code, name, serving,
      kcal: num(r.kcal, `${at} kcal`),
      protein_g: num(r.protein_g, `${at} protein_g`),
      carbs_g: num(r.carbs_g, `${at} carbs_g`),
      fat_g: num(r.fat_g, `${at} fat_g`),
      reason: str(r.reason),
    });
  }

  const summary = isObj(raw.summary) ? raw.summary : {};
  const reply: Reply = {
    schema: REPLY_SCHEMA,
    batch_id: batch.id,
    meals,
    remember,
    summary: { text: str(summary.text) ?? "", suggestion: str(summary.suggestion) },
  };
  return errors.length ? { reply: null, errors } : { reply, errors };
}
