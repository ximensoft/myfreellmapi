// Native Anthropic wire-format forwarder. When a custom provider also exposes
// a native Anthropic-compatible endpoint (stored as `anthropic_base_url` on
// the api_keys row), the /v1/messages route forwards the ORIGINAL Anthropic
// request body directly — no OpenAI conversion — so strict providers that
// reject reordered messages (e.g. "System message must be at the beginning")
// receive the exact wire format the client sent.
//
// Both the non-streaming and streaming paths are handled here. Errors carry
// the upstream HTTP status (via providerHttpError) so the existing retry /
// cooldown / fail-over machinery in the route works unchanged.

import type { Response as ExpressResponse } from 'express';
import type { RouteResult } from '../services/router.js';
import { proxyFetch } from './proxy.js';
import { providerHttpError, type ProviderHttpError } from '../providers/base.js';

const ANTHROPIC_VERSION = '2023-06-01';
const FORWARD_TIMEOUT_MS = 120_000;

/** Build the full messages endpoint URL from a base URL. */
function messagesEndpoint(anthropicBaseUrl: string): string {
  const base = anthropicBaseUrl.replace(/\/+$/, '');
  // If the user already included the full path, use it as-is.
  if (base.endsWith('/messages')) return base;
  if (base.endsWith('/v1')) return `${base}/messages`;
  return `${base}/v1/messages`;
}

/** Auth headers for the upstream Anthropic-compatible endpoint. We send both
 *  the standard `x-api-key` (Anthropic native) and `Authorization: Bearer`
 *  (accepted by most proxy/gateway implementations) so the key works regardless
 *  of the upstream's auth scheme. */
function authHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'Authorization': `Bearer ${apiKey}`,
  };
}

export interface AnthropicForwardResult {
  /** The raw Anthropic message response (already in wire format). */
  body: Record<string, unknown>;
  /** Input tokens reported by the upstream (0 if absent). */
  inputTokens: number;
  /** Output tokens reported by the upstream (0 if absent). */
  outputTokens: number;
}

/** Forward a non-streaming Anthropic /v1/messages request natively. */
export async function forwardAnthropicRequest(
  route: RouteResult,
  requestBody: Record<string, unknown>,
): Promise<AnthropicForwardResult> {
  const url = messagesEndpoint(route.anthropicBaseUrl!);
  // Replace the model field with the routed model id so the upstream serves
  // the model the router selected (not the Claude alias the client sent).
  // Strip `stream` so the upstream returns a single JSON response.
  const { stream: _stream, ...rest } = requestBody;
  const body = { ...rest, model: route.modelId };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const upstream = await proxyFetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(route.apiKey),
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, route.platform);
    return await parseAnthropicResponse(upstream, route);
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw makeError(route, `timeout after ${FORWARD_TIMEOUT_MS}ms`);
    }
    // Transport errors (DNS, TLS, connection refused) — retryable.
    throw makeError(route, err.message ?? 'network error');
  } finally {
    clearTimeout(timeout);
  }
}

async function parseAnthropicResponse(
  upstream: globalThis.Response,
  route: RouteResult,
): Promise<AnthropicForwardResult> {
  if (!upstream.ok) {
    const errBody = await upstream.json().catch(() => ({}));
    const msg = (errBody as any)?.error?.message
      ?? (errBody as any)?.message
      ?? upstream.statusText;
    throw providerHttpError(
      upstream,
      `${route.platform} (anthropic) API error ${upstream.status}: ${msg}`,
    );
  }

  const data = await upstream.json() as Record<string, unknown>;
  const usage = (data as any).usage ?? {};
  return {
    body: data,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  };
}

// ── Streaming ────────────────────────────────────────────────────────────────

/** Forward a streaming Anthropic /v1/messages request natively. The upstream
 *  SSE events are piped directly to the client — they are already in the
 *  Anthropic wire format that Claude Code expects, so no translation is
 *  needed. Only the `model` field in the `message_start` event is rewritten
 *  to match the client's requested model name.
 *
 *  Throws a normal Error (pre-stream, retryable) or a StreamForwardStarted
 *  error (mid-stream, non-retryable) — mirroring the StreamAlreadyStarted
 *  pattern in the OpenAI conversion path. */
export class StreamForwardStarted extends Error {}

export interface StreamForwardCtx {
  start: number;
  attempt: number;
  requestedModel: string;
  estimatedInputTokens: number;
  pinnedModelId: string | null;
}

export async function streamAnthropicForward(
  res: ExpressResponse,
  route: RouteResult,
  requestBody: Record<string, unknown>,
  ctx: StreamForwardCtx,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const url = messagesEndpoint(route.anthropicBaseUrl!);
  const body = { ...requestBody, model: route.modelId, stream: true };

  let messageStarted = false;
  let outputChars = 0;
  let inputTokens = ctx.estimatedInputTokens;
  let outputTokens = 0;

  const ensureHeaders = () => {
    if (messageStarted) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
    if (ctx.attempt > 0) res.setHeader('X-Fallback-Attempts', String(ctx.attempt));
    messageStarted = true;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const upstream = await proxyFetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders(route.apiKey),
        'Content-Type': 'application/json',
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, route.platform);

    if (!upstream.ok) {
      const errBody = await upstream.json().catch(() => ({}));
      const msg = (errBody as any)?.error?.message
        ?? (errBody as any)?.message
        ?? upstream.statusText;
      throw providerHttpError(
        upstream,
        `${route.platform} (anthropic) API error ${upstream.status}: ${msg}`,
      );
    }

    // Pipe the upstream SSE directly to the client, rewriting the model name
    // in message_start so the client sees its requested model.
    const reader = upstream.body?.getReader();
    if (!reader) throw new Error('No response body from upstream');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        // Pass through non-data lines (event: prefixes, blank separators) as-is.
        if (!line.startsWith('data: ')) {
          ensureHeaders();
          if (line.startsWith('event: ')) {
            res.write(`${line}\n`);
          }
          continue;
        }

        const data = line.slice(6);
        if (data === '[DONE]') {
          ensureHeaders();
          res.write(`data: [DONE]\n\n`);
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          // Rewrite the model field in message_start so the client sees the
          // model name it requested (Claude alias), not the upstream model id.
          if (parsed.type === 'message_start' && parsed.message) {
            parsed.message.model = ctx.requestedModel;
            if (parsed.message.usage?.input_tokens != null) {
              inputTokens = parsed.message.usage.input_tokens;
            }
          }
          // Capture output tokens from message_delta.
          if (parsed.type === 'message_delta' && parsed.usage?.output_tokens != null) {
            outputTokens = parsed.usage.output_tokens;
          }
          // Track output size for fallback token estimation.
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            outputChars += parsed.delta.text.length;
          }

          ensureHeaders();
          res.write(`data: ${JSON.stringify(parsed)}\n\n`);
        } catch {
          // Malformed JSON line — skip it (matching readSseStream tolerance).
        }
      }
    }

    ensureHeaders();
    res.end();

    if (outputTokens === 0) {
      outputTokens = Math.ceil(outputChars / 4);
    }

    return { inputTokens, outputTokens };
  } catch (err: any) {
    if (err instanceof StreamForwardStarted) throw err;

    if (err.name === 'AbortError') {
      err.message = `${route.platform} (anthropic) stream timeout after ${FORWARD_TIMEOUT_MS}ms`;
    }

    if (messageStarted) {
      // Real payload already reached the client — finish honestly.
      res.write(`event: error\ndata: ${JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: `Provider error (${route.displayName}): stream interrupted` },
      })}\n\n`);
      try { res.end(); } catch { /* socket gone */ }
      throw new StreamForwardStarted();
    }

    // Headers never sent — bubble to the outer loop for failover.
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Build an error compatible with the retry loop (carries status for
 *  isRetryableError classification). */
function makeError(route: RouteResult, message: string): ProviderHttpError {
  const err = new Error(`${route.platform} (anthropic) ${message}`) as ProviderHttpError;
  err.status = 503; // transport-level → retryable
  return err;
}
