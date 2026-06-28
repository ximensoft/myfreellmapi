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

  for (const profile of profiles) {
    let nextPriority = (getMaxPriority.get(profile.id) as { m: number }).m + 1;
    for (const row of fallbackRows) {
      const exists = hasProfileModel.get(profile.id, row.model_db_id);
      if (!exists) {
        insertProfileModel.run(profile.id, row.model_db_id, nextPriority, row.enabled);
        nextPriority++;
      }
    }
  }
}

export function down(_db: Database.Database): void {
  // No-op: removing profile_models entries would lose user customizations.
  // The up migration only adds missing rows, which is safe to leave in place.
}
