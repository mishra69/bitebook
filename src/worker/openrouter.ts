// Reading an OpenRouter chat completion (kept apart from analyze.ts so unit tests can load it).
export type Completion = {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number };
} | null;

// The reply text, or an error that says what went wrong.
export function replyText(status: number, ok: boolean, body: Completion): string {
  const text = body?.choices?.[0]?.message?.content;
  if (!ok || !text) throw new Error(`openrouter ${status}: ${body?.error?.message ?? "no reply text"}`.slice(0, 300));
  // Cut off at max_tokens: the JSON would be incomplete. Say so, rather than "invalid reply".
  if (body.choices![0].finish_reason === "length") throw new Error("reply cut off at max_tokens");
  return text;
}
