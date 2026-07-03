// Migration: Add anthropic_base_url column to api_keys
// Created: 2026-07-03
//
// Custom providers that also expose a native Anthropic-compatible endpoint
// (e.g. SenseNova-2) can store that URL here. When a request arrives through
// the Anthropic /v1/messages route and the selected key has this field set,
// the original Anthropic wire-format body is forwarded directly — bypassing
// the OpenAI-format conversion that can corrupt message ordering for strict
// providers (issue: "System message must be at the beginning").
//
// NULL for every built-in platform and custom providers without an Anthropic
// endpoint. Only meaningful for rows where is_custom = 1.
//
// DOWN: reversible

import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'anthropic_base_url')) {
    db.prepare('ALTER TABLE api_keys ADD COLUMN anthropic_base_url TEXT').run();
  }
}

export function down(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(api_keys)').all() as { name: string }[];
  if (columns.some(col => col.name === 'anthropic_base_url')) {
    // SQLite < 3.35 doesn't support DROP COLUMN; recreate without it.
    // For simplicity and safety, just leave the column — it's harmless.
    // On newer SQLite (3.35+), DROP COLUMN works:
    try {
      db.prepare('ALTER TABLE api_keys DROP COLUMN anthropic_base_url').run();
    } catch {
      // Older SQLite: no-op (column stays but is unused).
    }
  }
}
