// Permanently removes meals deleted more than PURGE_AFTER_DAYS ago: their R2 files
// and every row that belongs to them. Runs daily from the cron trigger in
// wrangler.jsonc, across all users (it's an operator job, not a user request).
// Every table that hangs off a meal must be purged here too (analyses, voice notes, analysis
// jobs; questions keep their text, since later prompts list them, but lose the meal).
export const PURGE_AFTER_DAYS = 30;
const BATCH = 100;

export async function purgeDeleted(env: Env, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - PURGE_AFTER_DAYS * 86_400_000).toISOString();
  // The phone's diagnostics log is only for recent trouble (D23).
  await env.DB.prepare("DELETE FROM diag_events WHERE t_ms < ?1").bind(now - PURGE_AFTER_DAYS * 86_400_000).run();
  let purged = 0;
  for (;;) {
    const { results: meals } = await env.DB.prepare(
      "SELECT id FROM meals WHERE deleted_at IS NOT NULL AND deleted_at < ?1 LIMIT ?2",
    )
      .bind(cutoff, BATCH)
      .all<{ id: string }>();
    if (meals.length === 0) return purged;
    const ids = JSON.stringify(meals.map((m) => m.id));

    const { results: photos } = await env.DB.prepare(
      "SELECT original_key, display_key FROM photos WHERE meal_id IN (SELECT value FROM json_each(?1))",
    )
      .bind(ids)
      .all<{ original_key: string; display_key: string }>();
    const { results: voices } = await env.DB.prepare("SELECT r2_key FROM voice_notes WHERE meal_id IN (SELECT value FROM json_each(?1))")
      .bind(ids)
      .all<{ r2_key: string }>();
    const keys = [...photos.flatMap((p) => [p.original_key, p.display_key]), ...voices.map((v) => v.r2_key)];
    // Files first: if this fails, the rows remain and tomorrow's run tries again.
    // (Deleting a key that's already gone, e.g. an original rolled off locally, is a no-op.)
    for (let i = 0; i < keys.length; i += 1000) await env.PHOTOS.delete(keys.slice(i, i + 1000));

    await env.DB.batch([
      env.DB.prepare("DELETE FROM analysis_jobs WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("UPDATE questions SET meal_id = NULL WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("DELETE FROM analyses WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("DELETE FROM voice_notes WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("DELETE FROM photos WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("DELETE FROM meals WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
    ]);
    purged += meals.length;
    console.log(`purged ${meals.length} meal(s), ${keys.length} file(s)`);
  }
}
