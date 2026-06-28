// Migration: Add is_custom column to api_keys, models, embedding_models, media_models
// Created: 2026-06-28
//
// Enables custom models to use user-defined platform names instead of the fixed
// 'custom' value. The is_custom column is the authoritative way to distinguish
// user-added endpoints from built-in catalog models.
//
// DOWN: reversible

import type Database from 'better-sqlite3';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(col => col.name === column);
}

export function up(db: Database.Database): void {
  // Add is_custom to api_keys
  if (!hasColumn(db, 'api_keys', 'is_custom')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0').run();
  }
  // Backfill: any existing row with platform = 'custom' is a custom key
  db.prepare("UPDATE api_keys SET is_custom = 1 WHERE platform = 'custom'").run();

  // Add is_custom to models
  if (!hasColumn(db, 'models', 'is_custom')) {
    db.prepare('ALTER TABLE models ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0').run();
  }
  // Backfill: any existing row with platform = 'custom' is a custom model
  db.prepare("UPDATE models SET is_custom = 1 WHERE platform = 'custom'").run();

  // Add is_custom to embedding_models
  if (!hasColumn(db, 'embedding_models', 'is_custom')) {
    db.prepare('ALTER TABLE embedding_models ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0').run();
  }
  db.prepare("UPDATE embedding_models SET is_custom = 1 WHERE platform = 'custom'").run();

  // Add is_custom to media_models
  if (!hasColumn(db, 'media_models', 'is_custom')) {
    db.prepare('ALTER TABLE media_models ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0').run();
  }
  db.prepare("UPDATE media_models SET is_custom = 1 WHERE platform = 'custom'").run();

  // Add indexes for the new column
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

  if (hasColumn(db, 'media_models', 'is_custom')) {
    db.prepare('ALTER TABLE media_models DROP COLUMN is_custom').run();
  }
  if (hasColumn(db, 'embedding_models', 'is_custom')) {
    db.prepare('ALTER TABLE embedding_models DROP COLUMN is_custom').run();
  }
  if (hasColumn(db, 'models', 'is_custom')) {
    db.prepare('ALTER TABLE models DROP COLUMN is_custom').run();
  }
  if (hasColumn(db, 'api_keys', 'is_custom')) {
    db.prepare('ALTER TABLE api_keys DROP COLUMN is_custom').run();
  }
}
