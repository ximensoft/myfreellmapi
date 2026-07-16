// Migration: Add request history fields to requests table
// Created: 2026-07-15
//
// DOWN: reversible

import type Database from 'better-sqlite3';

export function up(db: Database.Database): void {
  db.exec(`
    -- Add columns for storing request and response content
    ALTER TABLE requests ADD COLUMN request_body TEXT;
    ALTER TABLE requests ADD COLUMN response_body TEXT;
    ALTER TABLE requests ADD COLUMN provider TEXT;
    
    -- Create index for efficient querying of recent requests
    CREATE INDEX IF NOT EXISTS idx_requests_created_at_desc ON requests(created_at DESC);
  `);
}

export function down(db: Database.Database): void {
  db.exec(`
    -- Remove the added columns (SQLite doesn't support DROP COLUMN, so we recreate the table)
    CREATE TABLE requests_old AS SELECT 
      id, platform, model_id, key_id, status, input_tokens, output_tokens, 
      latency_ms, error, created_at
    FROM requests;
    
    DROP TABLE requests;
    
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    INSERT INTO requests SELECT * FROM requests_old;
    DROP TABLE requests_old;
    
    -- Recreate indexes
    CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_platform ON requests(platform);
  `);
}