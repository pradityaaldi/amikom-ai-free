/**
 * Runtime configuration, read from environment variables.
 *
 * Every value has a sane default so the gateway can be started with `node server.js`.
 */

function parseIntOr(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  const items = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

const defaultTeam = process.env.AMIKOM_DEFAULT_TEAM || 'miko';

export const config = {
  /** Bind address of the gateway. */
  host: process.env.HOST || '127.0.0.1',
  /** Port of the gateway. */
  port: parseIntOr(process.env.PORT, 8787),

  /** Base URL of the AMIKOM agentic backend (no trailing slash). */
  baseUrl: (process.env.AMIKOM_BASE_URL || 'https://ai.amikom.ac.id/agentic_backend').replace(/\/+$/, ''),

  /** Team used when the requested model is not a known team id. */
  defaultTeam,

  /** Team ids exposed through `/v1/models` and accepted as model ids. */
  teams: list(process.env.AMIKOM_TEAMS, [defaultTeam]),

  /**
   * Optional API key clients must present. If empty the gateway is open
   * (recommended: keep it bound to localhost).
   */
  apiKey: process.env.AMIKOM_GATEWAY_KEY || '',

  /**
   * How to pick the upstream `session_id` (upstream keeps conversation memory
   * keyed by it):
   *   - "derive" (default): stable UUID derived from the first user message
   *   - "random":           a fresh UUID for every request (no memory)
   *   - "header":           only use client supplied session id
   */
  sessionStrategy: process.env.AMIKOM_SESSION_STRATEGY || 'derive',

  /**
   * What to send upstream as the user `message`:
   *   - "last" (default): only the newest user turn, rely on upstream memory
   *   - "full":           the whole transcript flattened into one prompt
   */
  contextMode: process.env.AMIKOM_CONTEXT_MODE || 'last',

  /**
   * Prompt-based tool calling, for harnesses that send OpenAI `tools`:
   *   - "auto" (default): enable the shim whenever the request contains tools
   *   - "shim":           always enable (also for plain chat)
   *   - "off":            never enable (client tools are ignored)
   */
  toolMode: process.env.AMIKOM_TOOL_MODE || 'auto',

  /** Upstream request timeout in milliseconds. */
  requestTimeoutMs: parseIntOr(process.env.AMIKOM_TIMEOUT_MS, 180000),

  /** Interval for SSE keep-alive comments, in milliseconds (0 disables). */
  keepAliveMs: parseIntOr(process.env.AMIKOM_KEEPALIVE_MS, 15000),
};
