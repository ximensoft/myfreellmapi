/**
 * Compact logger — appends every /v1/responses/compact request to
 * logs/compact.log for evaluation and tracing. Unlike the console log
 * (which is a one-line summary), this file captures the FULL request
 * and response bodies so compaction quality can be evaluated offline.
 *
 * Format: JSON-lines (one JSON object per line).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LOG_DIR = process.env.FREEAPI_LOG_DIR?.trim()
  || path.resolve(__dirname, '../../logs');

const COMPACT_LOG_PATH = path.join(LOG_DIR, 'compact.log');

// Ensure the directory exists synchronously on module load.
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Non-fatal — the per-write call below will try again.
}

export interface CompactLogEntry {
  /** ISO timestamp */
  timestamp: string;
  /** Model requested in the compaction body */
  requestModel: string;
  /** Number of items in the input array */
  inputItemCount: number;
  /** Request body size in bytes */
  requestSize: number;
  /** HTTP status from upstream (0 = network error) */
  httpStatus: number;
  /** Number of items in the output array */
  outputItemCount: number;
  /** Response body size in bytes */
  responseSize: number;
  /** End-to-end latency in milliseconds */
  latencyMs: number;
  /** Error message if the request failed */
  error?: string;
  /** Full request body (JSON string) */
  requestBody: string;
  /** Full response body (JSON string, empty on network error) */
  responseBody: string;
}

/**
 * Append a compaction event to logs/compact.log.
 *
 * Safe to call from any catch block — never throws. If the file system
 * is unavailable the log entry is silently dropped.
 */
export function logCompact(entry: CompactLogEntry): void {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(COMPACT_LOG_PATH, line, { encoding: 'utf8' });
  } catch {
    // Swallow — the console log already informed the user.
  }
}
