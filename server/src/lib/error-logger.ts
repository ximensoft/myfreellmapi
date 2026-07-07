/**
 * Error logger — appends every forwarding-API error to logs/error.log so the
 * full upstream error detail (including the raw response body that the
 * provider's own error message may not surface) is always available for
 * debugging. This complements the in-memory console.log / DB analytics which
 * truncate error messages.
 *
 * The log file is created under <server>/logs/error.log relative to the DB
 * directory (or FREEAPI_LOG_DIR env var if set). Entries are JSON-lines
 * format, one error per line.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the logs directory: prefer FREEAPI_LOG_DIR, then fall back to
// ../../logs relative to this source file (server/logs).
const LOG_DIR = process.env.FREEAPI_LOG_DIR?.trim()
  || path.resolve(__dirname, '../../logs');

const ERROR_LOG_PATH = path.join(LOG_DIR, 'error.log');

// Ensure the directory exists synchronously on module load (called once).
try {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
} catch {
  // Non-fatal — the per-write call below will try again.
}

export interface ErrorLogEntry {
  timestamp: string;
  route: string;
  platform: string;
  model: string;
  keyId: number;
  httpStatus: number;
  errorMessage: string;
  rawBody?: string;
  /** The request body sent to the upstream provider (JSON string, truncated to 10KB). */
  requestBody?: string;
  latencyMs: number;
  attempt: number;
  retryable: boolean;
  requestModel?: string | null;
}

/** Truncate a string to maxLen characters, appending an ellipsis if cut. */
function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

/** Maximum size for the request body stored in the error log (10KB).
 *  Large enough to capture the full messages array for most requests while
 *  preventing a single multi-megabyte log line for pathological inputs. */
const MAX_REQUEST_BODY_LOG_SIZE = 10_000;

/**
 * Append a forwarding-API error to logs/error.log.
 *
 * Safe to call from any catch block — never throws. If the file system is
 * unavailable the error is silently dropped (it's already been logged to
 * console + DB).
 */
export function logForwardingError(entry: ErrorLogEntry): void {
  try {
    // Truncate the request body to prevent multi-megabyte log lines.
    if (entry.requestBody && entry.requestBody.length > MAX_REQUEST_BODY_LOG_SIZE) {
      entry = { ...entry, requestBody: truncate(entry.requestBody, MAX_REQUEST_BODY_LOG_SIZE) };
    }
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(ERROR_LOG_PATH, line, { encoding: 'utf8' });
  } catch {
    // Swallow — the error is already visible in console.log and the DB.
  }
}
