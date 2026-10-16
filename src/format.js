/**
 * Helpers to convert between the OpenAI Chat Completions shape and the
 * AMIKOM agent event shape.
 */

import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Flatten an OpenAI message content value (string or content parts) to text. */
export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (typeof part.text === 'string') return part.text;
      if (part.type === 'text' && typeof part.content === 'string') return part.content;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Turn an arbitrary string into a canonical UUID. */
export function toUuid(input) {
  const value = String(input ?? '').trim();
  if (!value) return randomUUID();
  if (UUID_RE.test(value)) return value.toLowerCase();

  const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function firstUserText(messages) {
  const match = messages.find((m) => m?.role === 'user');
  return match ? extractText(match.content) : '';
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return extractText(messages[i].content);
  }
  return '';
}

/** Flatten the whole transcript into a single prompt (used by AMIKOM_CONTEXT_MODE=full). */
export function compileTranscript(messages) {
  const parts = [];
  for (const message of messages) {
    const text = extractText(message?.content);
    if (!text) continue;
    parts.push(`[${message.role}]\n${text}`);
  }
  return parts.join('\n\n');
}

/** Pick the upstream `message` value. */
export function buildMessage(messages) {
  if (config.contextMode === 'full') return compileTranscript(messages).trim() || 'Hello';
  return lastUserText(messages).trim() || 'Hello';
}

/** Resolve the upstream `session_id` from headers, body, or a derived hash. */
export function resolveSessionId(headers, body, messages) {
  const header = (name) => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };

  const supplied =
    header('x-session-id') ||
    header('session_id') ||
    header('x-client-request-id') ||
    header('x-session-affinity') ||
    (typeof body.session_id === 'string' ? body.session_id : '') ||
    (typeof body.user === 'string' ? `user:${body.user}` : '');

  if (supplied) return toUuid(supplied);
  if (config.sessionStrategy === 'random') return randomUUID();

  // "derive": stable per conversation, so multi-turn requests keep upstream memory.
  const basis = firstUserText(messages) || compileTranscript(messages) || 'anonymous';
  return toUuid(basis);
}

/** Map AMIKOM metrics to an OpenAI usage object. */
export function mapUsage(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;

  const input = Number(metrics.input_tokens) || 0;
  const output = Number(metrics.output_tokens) || 0;
  const cacheRead = Number(metrics.cache_read_tokens) || 0;
  const cacheWrite = Number(metrics.cache_write_tokens) || 0;
  const reasoning = Number(metrics.reasoning_tokens) || 0;

  const promptTokens = input + cacheRead + cacheWrite;
  const completionTokens = output;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
    },
    completion_tokens_details: {
      reasoning_tokens: reasoning,
    },
  };
}

/** OpenAI error payload. */
export function errorPayload(message, type = 'invalid_request_error', code = null) {
  return { error: { message, type, param: null, code } };
}

export function newCompletionId() {
  return `chatcmpl-${randomUUID()}`;
}
