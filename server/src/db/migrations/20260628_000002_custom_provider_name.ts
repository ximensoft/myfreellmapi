// Migration: Backfill is_custom data and create indexes
// Created: 2026-06-28
//
// Enables custom models to use user-defined platform names instead of the fixed
// 'custom' value. The is_custom COLUMN itself is added by the legacy baseline
// (ensureApiKeysIsCustomColumn, ensureModelsIsCustomColumn, and the embedding/
// media equivalents in their respective migration functions). This migration
// handles only the DATA backfill (marking existing 'custom' rows) and index
// creation, so it is safe to run up/down repeatedly without column-order issues.
//
// DOWN: reversible (drops indexes, resets is_custom to 0)

import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  // Backfill: any existing row with platform = 'custom' is a custom key/model
  db.prepare("UPDATE api_keys SET is_custom = 1 WHERE platform = 'custom'").run();
  db.prepare("UPDATE models SET is_custom = 1 WHERE platform = 'custom'").run();
  db.prepare("UPDATE embedding_models SET is_custom = 1 WHERE platform = 'custom'").run();
  db.prepare("UPDATE media_models SET is_custom = 1 WHERE platform = 'custom'").run();

  // Add indexes for the is_custom column
  db.prepare('CREATE INDEX IF NOT EXISTS idx_api_keys_is_custom ON api_keys(is_custom)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_models_is_custom ON models(is_custom)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_embedding_models_is_custom ON embedding_models(is_custom)').run();
  db.prepare('CREATE INDEX IF NOT EXISTS idx_media_models_is_custom ON media_models(is_custom)').run();
}

export function down(db: Database.Database): void {
  db.prepare('DROP INDEX IF EXISTS idx_media_models_is_custom').run();
  db.prepare('DROP INDEX IF EXISTS idx_embedding_models_is_custom').run();
  db.prepare('DROP INDEX IF EXISTS idx_models_is_custom').run();
  db.prepare('DROP INDEX IF EXISTS idx_api_keys_is_custom').run();

  // Reset backfill so re-running up() produces the same state
  db.prepare("UPDATE api_keys SET is_custom = 0 WHERE platform = 'custom'").run();
  db.prepare("UPDATE models SET is_custom = 0 WHERE platform = 'custom'").run();
  db.prepare("UPDATE embedding_models SET is_custom = 0 WHERE platform = 'custom'").run();
  db.prepare("UPDATE media_models SET is_custom = 0 WHERE platform = 'custom'").run();
}
