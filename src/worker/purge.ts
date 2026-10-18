// Permanently removes meals deleted more than PURGE_AFTER_DAYS ago: their R2 files
// and every row that belongs to them. Runs daily from the cron trigger in
// wrangler.jsonc, across all users (it's an operator job, not a user request).
// Tables added later that hang off a meal (analyses, corrections) must be purged here too.
export const PURGE_AFTER_DAYS = 30;
const BATCH = 100;

export async function purgeDeleted(env: Env, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - PURGE_AFTER_DAYS * 86_400_000).toISOString();
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
    const keys = photos.flatMap((p) => [p.original_key, p.display_key]);
    // Files first: if this fails, the rows remain and tomorrow's run tries again.
    // (Deleting a key that's already gone, e.g. an original rolled off locally, is a no-op.)
    for (let i = 0; i < keys.length; i += 1000) await env.PHOTOS.delete(keys.slice(i, i + 1000));

    await env.DB.batch([
      env.DB.prepare("DELETE FROM photos WHERE meal_id IN (SELECT value FROM json_each(?1))").bind(ids),
      env.DB.prepare("DELETE FROM meals WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
    ]);
    purged += meals.length;
    console.log(`purged ${meals.length} meal(s), ${keys.length} file(s)`);
  }
}
