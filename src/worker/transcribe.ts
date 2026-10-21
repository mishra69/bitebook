// Turns a meal's voice note into text with Whisper on Workers AI (D21). Runs right after the
// meal is saved, and again when a batch is created if it hasn't succeeded yet. A failure is
// recorded, never thrown: a missing transcript must not block saving or exporting a meal.
export const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

type Env = Cloudflare.Env & { TRANSCRIBE_STUB?: string };

export async function transcribe(env: Env, userId: string, mealId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT r2_key, transcript FROM voice_notes WHERE meal_id = ?1 AND user_id = ?2",
  )
    .bind(mealId, userId)
    .first<{ r2_key: string; transcript: string | null }>();
  if (!row) return null;
  if (row.transcript !== null) return row.transcript;

  let text: string;
  let model = TRANSCRIBE_MODEL;
  try {
    const obj = await env.PHOTOS.get(row.r2_key);
    if (!obj) throw new Error("audio missing from R2");
    const audio = new Uint8Array(await obj.arrayBuffer());
    if (env.TRANSCRIBE_STUB === "1") {
      // End-to-end tests run without Workers AI: a fixed, recognisable transcript.
      text = `(test transcript of ${audio.length} bytes)`;
      model = "stub";
    } else {
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
      text = (out.text ?? "").trim();
    }
  } catch (e) {
    const msg = String((e as Error).message ?? e).slice(0, 300);
    console.error(`transcribe ${mealId}:`, msg);
    await env.DB.prepare("UPDATE voice_notes SET transcribe_error = ?3 WHERE meal_id = ?1 AND user_id = ?2").bind(mealId, userId, msg).run();
    return null;
  }
  await env.DB.prepare(
    `UPDATE voice_notes SET transcript = ?3, transcript_model = ?4, transcribed_at = ?5, transcribe_error = NULL
     WHERE meal_id = ?1 AND user_id = ?2`,
  )
    .bind(mealId, userId, text, model, new Date().toISOString())
    .run();
  return text;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
