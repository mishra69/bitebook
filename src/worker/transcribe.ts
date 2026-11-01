// Turns a meal's voice notes into text with Whisper on Workers AI (D21, D46). Runs right after
// the meal is saved, and again when a batch is created for any that haven't succeeded yet. A
// failure is recorded, never thrown: a missing transcript must not block saving or exporting.
export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

type Env = Cloudflare.Env & { TRANSCRIBE_STUB?: string };

// Every voice note of the meal, in order, transcribing those that aren't yet.
export async function transcribeMeal(env: Env, userId: string, mealId: string): Promise<{ id: string; recorded_at: string | null; transcript: string | null }[]> {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key, recorded_at, transcript FROM voice_notes WHERE meal_id = ?1 AND user_id = ?2 ORDER BY position",
  )
    .bind(mealId, userId)
    .all<{ id: string; r2_key: string; recorded_at: string | null; transcript: string | null }>();
  const out = [];
  for (const v of results) out.push({ id: v.id, recorded_at: v.recorded_at, transcript: v.transcript ?? (await transcribeOne(env, userId, v)) });
  return out;
}

async function transcribeOne(env: Env, userId: string, v: { id: string; r2_key: string }): Promise<string | null> {
  let text: string;
  let model: string;
  try {
    const obj = await env.PHOTOS.get(v.r2_key);
    if (!obj) throw new Error("audio missing from R2");
    ({ text, model } = await whisper(env, userId, new Uint8Array(await obj.arrayBuffer())));
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    console.error(`transcribe ${v.id}:`, msg);
    await env.DB.prepare("UPDATE voice_notes SET transcribe_error = ?3 WHERE id = ?1 AND user_id = ?2").bind(v.id, userId, msg).run();
    return null;
  }
  await env.DB.prepare(
    `UPDATE voice_notes SET transcript = ?3, transcript_model = ?4, transcribed_at = ?5, transcribe_error = NULL
     WHERE id = ?1 AND user_id = ?2`,
  )
    .bind(v.id, userId, text, model, new Date().toISOString())
    .run();
  return text;
}

// Audio to text. Also used for spoken answers and corrections on the API path (D28).
export async function whisper(env: Env, userId: string, audio: Uint8Array): Promise<{ text: string; model: string }> {
  if (env.TRANSCRIBE_STUB === "1") {
    // End-to-end tests run without Workers AI: a fixed, recognisable transcript.
    return { text: `(test transcript of ${audio.length} bytes)`, model: "stub" };
  }
  const names = await env.DB.prepare("SELECT name FROM foods WHERE user_id = ?1 AND status = 'active' LIMIT 40")
    .bind(userId)
    .all<{ name: string }>();
  const out = await env.AI.run(TRANSCRIBE_MODEL, {
    audio: toBase64(audio),
    task: "transcribe",
    vad_filter: true,
    // Spelling help for food names Whisper might not know.
    initial_prompt: ["A note about a meal I just ate.", ...names.results.map((n) => n.name)].join(" "),
  });
  return { text: (out.text ?? "").trim(), model: TRANSCRIBE_MODEL };
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
