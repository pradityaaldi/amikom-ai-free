/**
 * Thin client for the AMIKOM agentic backend.
 *
 *   POST {baseUrl}/teams/{teamId}/runs
 *   multipart/form-data: message, stream, session_id
 */

import { config } from './config.js';

export class UpstreamError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.teamId
 * @param {string} opts.message
 * @param {boolean} opts.stream
 * @param {string} [opts.sessionId]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<Response>}
 */
export async function runTeam({ teamId, message, stream, sessionId, signal }) {
  const url = `${config.baseUrl}/teams/${encodeURIComponent(teamId)}/runs`;

  const form = new FormData();
  form.set('message', message);
  form.set('stream', String(Boolean(stream)));
  if (sessionId) form.set('session_id', sessionId);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body: form,
      signal,
      headers: {
        Accept: stream ? 'text/event-stream' : 'application/json',
        Origin: 'https://ai.amikom.ac.id',
        Referer: 'https://ai.amikom.ac.id/',
        'User-Agent': 'amikom-openai-gateway/1.0',
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new UpstreamError(`Cannot reach AMIKOM backend: ${error.message}`, { status: 502 });
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    throw new UpstreamError(`AMIKOM backend returned HTTP ${response.status}`, {
      status: response.status,
      body: body.slice(0, 2000),
    });
  }

  return response;
}
