#!/usr/bin/env node
/**
 * AMIKOM AI <-> OpenAI-compatible gateway.
 *
 * Exposes:
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions   (streaming and non-streaming)
 *
 * It translates OpenAI Chat Completions requests into the AMIKOM agentic
 * backend's multipart form request and translates the resulting SSE/JSON back
 * into OpenAI-compatible responses.
 */

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { config } from './src/config.js';
import { runTeam, UpstreamError } from './src/upstream.js';
import { parseSSE } from './src/sse.js';
import {
  buildMessage,
  resolveSessionId,
  mapUsage,
  errorPayload,
  newCompletionId,
} from './src/format.js';
import { hasTools, buildToolPrompt, parseToolCalls, toOpenAIToolCalls } from './src/tools.js';

const MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MiB

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Api-Key, X-Session-Id, Session_id, X-Client-Request-Id, X-Session-Affinity',
    'Access-Control-Max-Age': '86400',
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...corsHeaders(),
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthorized(req) {
  if (!config.apiKey) return true;

  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) {
    return safeEqual(auth.slice(7).trim(), config.apiKey);
  }
  if (typeof req.headers['x-api-key'] === 'string') {
    return safeEqual(req.headers['x-api-key'], config.apiKey);
  }
  return false;
}

function resolveTeam(model) {
  if (typeof model === 'string') {
    const value = model.trim();
    if (value.startsWith('team:')) return value.slice(5) || config.defaultTeam;
    if (config.teams.includes(value)) return value;
  }
  return config.defaultTeam;
}

function createAbortScope(req, res) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Upstream timeout')), config.requestTimeoutMs);

  req.on('aborted', () => controller.abort(new Error('Client aborted')));
  res.on('close', () => {
    if (!res.writableEnded) controller.abort(new Error('Client disconnected'));
  });

  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// Chat completions
// ---------------------------------------------------------------------------

function normalizeMessages(body) {
  if (!Array.isArray(body.messages)) return [];
  return body.messages;
}

async function handleStreaming(req, res, { body, messages, teamId, message, sessionId, signal }) {
  const upstream = await runTeam({ teamId, message, stream: true, sessionId, signal });
  const includeUsage = body.stream_options?.include_usage === true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });

  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : config.defaultTeam;

  let keepAlive = null;
  if (config.keepAliveMs > 0) {
    keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* ignore */
      }
    }, config.keepAliveMs);
  }

  const sendChunk = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const sendDelta = (delta, finishReason = null, usage) => {
    const chunk = {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    sendChunk(chunk);
  };

  sendDelta({ role: 'assistant', content: '' });

  let contentEmitted = false;
  let reasoningEmitted = false;
  let finalContent = '';
  let finalReasoning = '';
  let runUsage = null;
  let accumulated = null;

  try {
    for await (const event of parseSSE(upstream.body)) {
      if (event.data === '[DONE]') break;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }

      switch (data.event) {
        case 'TeamRunContent': {
          const reasoning = typeof data.reasoning_content === 'string' ? data.reasoning_content : '';
          const content = typeof data.content === 'string' ? data.content : '';
          if (reasoning) {
            reasoningEmitted = true;
            sendDelta({ reasoning_content: reasoning });
          }
          if (content) {
            contentEmitted = true;
            sendDelta({ content });
          }
          break;
        }
        case 'TeamModelRequestCompleted': {
          accumulated = addUsage(accumulated, data);
          break;
        }
        case 'TeamRunCompleted': {
          if (typeof data.content === 'string') finalContent = data.content;
          if (typeof data.reasoning_content === 'string') finalReasoning = data.reasoning_content;
          runUsage = mapUsage(data.metrics);
          break;
        }
        default:
          break;
      }
    }

    // Fallbacks: if nothing was streamed, emit the final answer once.
    if (!contentEmitted && finalContent) sendDelta({ content: finalContent });
    if (!reasoningEmitted && finalReasoning) sendDelta({ reasoning_content: finalReasoning });

    const usage = runUsage || mapUsage(accumulated);

    sendDelta({}, 'stop');

    if (includeUsage && usage) {
      sendChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage,
      });
    }

    res.write('data: [DONE]\n\n');
  } catch (error) {
    if (!res.writableEnded) {
      sendChunk(errorPayload(`Upstream stream error: ${error.message}`, 'upstream_error'));
      res.write('data: [DONE]\n\n');
    }
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    res.end();
  }
}

/** Sum the per-model-request metrics into a metrics-like object. */
function addUsage(accumulated, data) {
  const next = accumulated || {
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
  };
  next.input_tokens += Number(data.input_tokens) || 0;
  next.output_tokens += Number(data.output_tokens) || 0;
  next.reasoning_tokens += Number(data.reasoning_tokens) || 0;
  next.cache_read_tokens += Number(data.cache_read_tokens) || 0;
  next.cache_write_tokens += Number(data.cache_write_tokens) || 0;
  next.total_tokens += Number(data.total_tokens) || 0;
  return next;
}

async function handleNonStreaming(req, res, { body, teamId, message, sessionId, signal }) {
  const upstream = await runTeam({ teamId, message, stream: false, sessionId, signal });
  const data = await upstream.json();

  const content = typeof data.content === 'string' ? data.content : '';
  const reasoning = typeof data.reasoning_content === 'string' ? data.reasoning_content : '';

  const messagePayload = { role: 'assistant', content };
  if (reasoning) messagePayload.reasoning_content = reasoning;

  const usage = mapUsage(data.metrics) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  sendJson(res, 200, {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : config.defaultTeam,
    choices: [
      {
        index: 0,
        message: messagePayload,
        finish_reason: 'stop',
      },
    ],
    usage,
    system_fingerprint: `amikom-gateway:${data.run_id || 'unknown'}`,
  });
}

// --- Tool shim (prompt-based tool calling) --------------------------------

async function handleNonStreamingTools(req, res, { body, teamId, message, sessionId, signal }) {
  const upstream = await runTeam({ teamId, message, stream: false, sessionId, signal });
  const data = await upstream.json();

  const parsed = parseToolCalls(data.content || '');
  const reasoning = typeof data.reasoning_content === 'string' ? data.reasoning_content : '';
  const usage = mapUsage(data.metrics) || {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };

  const messagePayload = { role: 'assistant' };
  if (parsed.toolCalls.length > 0) {
    messagePayload.content = parsed.content || null;
    messagePayload.tool_calls = toOpenAIToolCalls(parsed.toolCalls);
  } else {
    messagePayload.content = parsed.content;
  }
  if (reasoning) messagePayload.reasoning_content = reasoning;

  sendJson(res, 200, {
    id: newCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === 'string' ? body.model : config.defaultTeam,
    choices: [
      {
        index: 0,
        message: messagePayload,
        finish_reason: parsed.toolCalls.length > 0 ? 'tool_calls' : 'stop',
      },
    ],
    usage,
    system_fingerprint: `amikom-gateway:${data.run_id || 'unknown'}`,
  });
}

async function handleStreamingTools(req, res, { body, teamId, message, sessionId, signal }) {
  const upstream = await runTeam({ teamId, message, stream: true, sessionId, signal });
  const includeUsage = body.stream_options?.include_usage === true;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });

  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const model = typeof body.model === 'string' ? body.model : config.defaultTeam;

  let keepAlive = null;
  if (config.keepAliveMs > 0) {
    keepAlive = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* ignore */
      }
    }, config.keepAliveMs);
  }

  const sendDelta = (delta, finishReason = null) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`,
    );
  };

  // Reasoning streams live; final content is buffered so we can detect tool calls.
  sendDelta({ role: 'assistant', content: '' });

  let contentBuffer = '';
  let finalContent = '';
  let runUsage = null;
  let accumulated = null;

  try {
    for await (const event of parseSSE(upstream.body)) {
      if (event.data === '[DONE]') break;

      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        continue;
      }

      switch (data.event) {
        case 'TeamRunContent': {
          const reasoning = typeof data.reasoning_content === 'string' ? data.reasoning_content : '';
          const content = typeof data.content === 'string' ? data.content : '';
          if (reasoning) sendDelta({ reasoning_content: reasoning });
          if (content) contentBuffer += content;
          break;
        }
        case 'TeamModelRequestCompleted':
          accumulated = addUsage(accumulated, data);
          break;
        case 'TeamRunCompleted':
          if (typeof data.content === 'string') finalContent = data.content;
          runUsage = mapUsage(data.metrics);
          break;
        default:
          break;
      }
    }

    const parsed = parseToolCalls(contentBuffer || finalContent);
    const usage = runUsage || mapUsage(accumulated);

    if (parsed.toolCalls.length > 0) {
      toOpenAIToolCalls(parsed.toolCalls).forEach((call, index) => {
        sendDelta({
          tool_calls: [{ index, id: call.id, type: 'function', function: call.function }],
        });
      });
      sendDelta({}, 'tool_calls');
    } else {
      if (parsed.content) sendDelta({ content: parsed.content });
      sendDelta({}, 'stop');
    }

    if (includeUsage && usage) {
      res.write(
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage,
        })}\n\n`,
      );
    }
    res.write('data: [DONE]\n\n');
  } catch (error) {
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify(errorPayload(`Upstream stream error: ${error.message}`, 'upstream_error'))}\n\n`,
      );
      res.write('data: [DONE]\n\n');
    }
  } finally {
    if (keepAlive) clearInterval(keepAlive);
    res.end();
  }
}

async function handleChatCompletions(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    sendJson(res, 400, errorPayload(error.message));
    return;
  }

  const messages = normalizeMessages(body);
  if (messages.length === 0) {
    sendJson(res, 400, errorPayload('`messages` must be a non-empty array'));
    return;
  }

  const teamId = resolveTeam(body.model);
  const toolsEnabled = config.toolMode === 'shim' || (config.toolMode === 'auto' && hasTools(body));

  // Tool shim is stateless: the full transcript is replayed every request, so we
  // use a fresh upstream session to avoid duplicating the history in its memory.
  const message = toolsEnabled
    ? buildToolPrompt({ tools: body.tools, messages })
    : buildMessage(messages);
  const sessionId = toolsEnabled
    ? randomUUID()
    : resolveSessionId(req.headers, body, messages);
  const scope = createAbortScope(req, res);

  try {
    if (toolsEnabled) {
      if (body.stream === true) {
        await handleStreamingTools(req, res, { body, messages, teamId, message, sessionId, signal: scope.signal });
      } else {
        await handleNonStreamingTools(req, res, { body, teamId, message, sessionId, signal: scope.signal });
      }
    } else if (body.stream === true) {
      await handleStreaming(req, res, { body, messages, teamId, message, sessionId, signal: scope.signal });
    } else {
      await handleNonStreaming(req, res, { body, teamId, message, sessionId, signal: scope.signal });
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;

    if (error instanceof UpstreamError) {
      if (!res.headersSent) {
        sendJson(res, 502, errorPayload(error.message, 'upstream_error', error.status ?? null));
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (!res.headersSent) {
      sendJson(res, 500, errorPayload(error.message, 'internal_error'));
    } else {
      res.end();
    }
  } finally {
    scope.dispose();
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

function handleModels(res) {
  const created = Math.floor(Date.now() / 1000);
  sendJson(res, 200, {
    object: 'list',
    data: config.teams.map((team) => ({
      id: team,
      object: 'model',
      created,
      owned_by: 'amikom',
      permission: [],
    })),
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, errorPayload('Invalid or missing API key', 'authentication_error'));
    return;
  }

  if (path === '/' || path === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'amikom-ai-free-gateway',
      upstream: config.baseUrl,
      teams: config.teams,
      default_team: config.defaultTeam,
      session_strategy: config.sessionStrategy,
      context_mode: config.contextMode,
      tool_mode: config.toolMode,
    });
    return;
  }

  if (path === '/v1/models' && req.method === 'GET') {
    handleModels(res);
    return;
  }

  if (path === '/v1/chat/completions' && req.method === 'POST') {
    await handleChatCompletions(req, res);
    return;
  }

  sendJson(res, 404, errorPayload(`Unknown route: ${req.method} ${url.pathname}`, 'not_found_error'));
});

server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`amikom-openai-gateway listening on ${base}`);
  console.log(`  upstream        : ${config.baseUrl}`);
  console.log(`  teams           : ${config.teams.join(', ')}`);
  console.log(`  session strategy: ${config.sessionStrategy}`);
  console.log(`  context mode    : ${config.contextMode}`);
  console.log(`  tool mode       : ${config.toolMode}`);
  console.log(`  chat endpoint   : POST ${base}/v1/chat/completions`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
