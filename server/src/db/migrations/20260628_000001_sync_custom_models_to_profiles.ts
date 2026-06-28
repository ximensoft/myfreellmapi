import type Database from 'better-sqlite3';

/**
 * Backfill custom models into profile_models.
 *
 * When a custom model was added (POST /api/keys/custom), it was inserted into
 * fallback_config but NOT into profile_models. Since getActiveChain() reads
 * from profile_models when an active profile is set, custom models were
 * invisible to the router — they never appeared in the auto-routing chain.
 * This migration adds any custom models missing from profile_models, and also
 * backfills any fallback_config rows that are absent from profile_models
 * (covering the general case where models added by catalog migrations may
 * have been missed too).
 */
export function up(db: Database.Database): void {
  // For each profile, find models in fallback_config that are missing from
  // profile_models and append them at the end (lowest priority).
  const profiles = db.prepare('SELECT id FROM profiles').all() as { id: number }[];

  const getMaxPriority = db.prepare(
    'SELECT COALESCE(MAX(priority), 0) AS m FROM profile_models WHERE profile_id = ?',
  );

  const hasProfileModel = db.prepare(
    'SELECT 1 FROM profile_models WHERE profile_id = ? AND model_db_id = ?',
  );

  const insertProfileModel = db.prepare(
    'INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)',
  );

  // Get all fallback_config entries (these are the source of truth for models
  // that should be in profiles).
  const fallbackRows = db.prepare(
    'SELECT model_db_id, priority, enabled FROM fallback_config ORDER BY priority ASC',
  ).all() as { model_db_id: number; priority: number; enabled: number }[];

  console.log(`[migration:sync-custom-profiles] profiles=${profiles.length}, fallback_rows=${fallbackRows.length}`);

  const insertedIds: number[] = [];
  let totalInserted = 0;
  for (const profile of profiles) {
    let nextPriority = (getMaxPriority.get(profile.id) as { m: number }).m + 1;
    let profileInserted = 0;
    for (const row of fallbackRows) {
      const exists = hasProfileModel.get(profile.id, row.model_db_id);
      if (!exists) {
        const info = insertProfileModel.run(profile.id, row.model_db_id, nextPriority, row.enabled);
        insertedIds.push(Number(info.lastInsertRowid));
        nextPriority++;
        profileInserted++;
      }
    }
    totalInserted += profileInserted;
    console.log(`[migration:sync-custom-profiles] profile_id=${profile.id}: inserted ${profileInserted} missing model(s)`);
  }

  // Persist the IDs we inserted so down() can remove exactly those rows.
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sync_custom_models_inserted_ids', ?)")
    .run(JSON.stringify(insertedIds));

  // Also log custom-specific stats
  const customInFc = db.prepare(
    "SELECT COUNT(*) AS cnt FROM fallback_config fc JOIN models m ON m.id = fc.model_db_id WHERE m.platform = 'custom'",
  ).get() as { cnt: number };
  const customInPm = db.prepare(
    "SELECT COUNT(*) AS cnt FROM profile_models pm JOIN models m ON m.id = pm.model_db_id WHERE m.platform = 'custom'",
  ).get() as { cnt: number };
  console.log(`[migration:sync-custom-profiles] done. total_inserted=${totalInserted}, custom_in_fallback=${customInFc.cnt}, custom_in_profiles=${customInPm.cnt}`);
}

export function down(db: Database.Database): void {
  // Remove exactly the rows this migration inserted (tracked in settings).
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sync_custom_models_inserted_ids'").get() as { value: string } | undefined;
  if (row) {
    try {
      const ids = JSON.parse(row.value) as number[];
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        db.prepare(`DELETE FROM profile_models WHERE id IN (${placeholders})`).run(...ids);
      }
    } catch { /* ignore malformed JSON */ }
    db.prepare("DELETE FROM settings WHERE key = 'sync_custom_models_inserted_ids'").run();
    // Reset the auto-increment counter so re-running up() produces the same IDs.
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'profile_models'").run();
  }
}
