/**
 * Prompt-based tool calling ("shim") for backends that do not support native
 * OpenAI function calling.
 *
 * The upstream only accepts a plain text `message` and has no concept of client
 * defined tools. To let agentic harnesses (pi, Cursor, ...) use their own tools
 * we:
 *   1. describe the client tools + a strict output format in the prompt,
 *   2. flatten the conversation (including tool calls/results) into that prompt,
 *   3. parse raw JSON tool calls out of the model output and translate them back
 *      into OpenAI `tool_calls`.
 *
 * NOTE: this is best effort. The AMIKOM agent is a topic-restricted assistant;
 * pointing the task at an "AMIKOM project" improves compliance a lot, but it is
 * still not as reliable as a model with native function calling.
 */

import { randomBytes } from 'node:crypto';
import { extractText } from './format.js';

const MAX_TOOL_DESCRIPTION = 300;

/** True when the request involves client tools in any way. */
export function hasTools(body) {
  if (Array.isArray(body?.tools) && body.tools.length > 0) return true;
  if (!Array.isArray(body?.messages)) return false;
  return body.messages.some(
    (m) =>
      m?.role === 'tool' ||
      (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0),
  );
}

function tryParseJson(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stripFences(value) {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(value.trim());
  return match ? match[1] : value;
}

function normalizeCall(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  const name = fn.name || fn.tool || fn.tool_name;
  if (typeof name !== 'string' || !name.trim()) return null;

  let args = fn.arguments ?? fn.args ?? fn.parameters ?? fn.parameters_json ?? {};
  if (typeof args === 'string') args = tryParseJson(args) ?? {};
  if (typeof args !== 'object' || args === null || Array.isArray(args)) args = {};

  return { name: name.trim(), arguments: args };
}

/**
 * Scan for every top-level `{...}` JSON object, respecting strings/escapes, and
 * return each with the byte range it occupies so callers can strip it out.
 */
function scanTopLevelObjects(text) {
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const slice = text.slice(start, i + 1);
        found.push({ start, end: i + 1, value: tryParseJson(slice) });
        start = -1;
      }
    }
  }

  return found;
}

/**
 * Parse tool calls out of raw model text.
 * @returns {{ toolCalls: {name: string, arguments: object}[], content: string }}
 */
export function parseToolCalls(text) {
  const raw = String(text ?? '');

  // 1) Explicit <tool_call>...</tool_call> blocks (some models prefer tags).
  const tagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  const tagged = [];
  let match;
  while ((match = tagRe.exec(raw)) !== null) {
    const call = normalizeCall(tryParseJson(match[1]));
    if (call) tagged.push(call);
  }
  if (tagged.length > 0) {
    return { toolCalls: tagged, content: raw.replace(tagRe, '').trim() };
  }

  // 2) One or more raw / pretty-printed JSON objects. Only accept them when the
  //    response contains nothing except those objects (so prose is never eaten).
  const scanned = scanTopLevelObjects(stripFences(raw));
  if (scanned.length > 0) {
    const calls = scanned.map((s) => normalizeCall(s.value)).filter(Boolean);
    if (calls.length === scanned.length) {
      let residue = '';
      let cursor = 0;
      for (const item of scanned) {
        residue += raw.slice(cursor, item.start);
        cursor = item.end;
      }
      residue += raw.slice(cursor);
      if (residue.trim() === '') return { toolCalls: calls, content: '' };
    }
  }

  // 3) A JSON array of tool calls.
  const whole = tryParseJson(stripFences(raw));
  if (Array.isArray(whole)) {
    const calls = whole.map(normalizeCall).filter(Boolean);
    if (calls.length === whole.length && calls.length > 0) {
      return { toolCalls: calls, content: '' };
    }
  }

  return { toolCalls: [], content: raw };
}

/** Convert parsed calls into OpenAI tool_call objects. */
export function toOpenAIToolCalls(calls) {
  return calls.map((call) => ({
    id: `call_${randomBytes(12).toString('hex')}`,
    type: 'function',
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  }));
}

function describeTools(tools) {
  return tools
    .map((tool) => {
      const fn = tool?.function ?? tool ?? {};
      const name = fn.name ?? 'unknown_tool';
      const description = String(fn.description ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, MAX_TOOL_DESCRIPTION);
      const parameters = fn.parameters ? JSON.stringify(fn.parameters) : '{}';
      return `- ${name} — params: ${parameters}${description ? ` — ${description}` : ''}`;
    })
    .join('\n');
}

function formatAssistantToolCalls(toolCalls) {
  return toolCalls
    .map((call) => {
      const fn = call?.function ?? call ?? {};
      let args = fn.arguments;
      if (typeof args === 'string') args = tryParseJson(args) ?? {};
      return JSON.stringify({ name: fn.name, arguments: args ?? {} });
    })
    .join('\n');
}

/** Flatten the conversation into a prompt that teaches the model to call tools. */
export function buildToolPrompt({ tools, messages }) {
  const systemText = messages
    .filter((m) => m?.role === 'system' || m?.role === 'developer')
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join('\n\n');

  const conversation = [];
  for (const message of messages) {
    if (!message || message.role === 'system' || message.role === 'developer') continue;

    if (message.role === 'user') {
      const text = extractText(message.content);
      if (text) conversation.push(`[user]\n${text}`);
    } else if (message.role === 'assistant') {
      const text = extractText(message.content);
      if (text) conversation.push(`[assistant]\n${text}`);
      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        conversation.push(`[assistant tool_calls]\n${formatAssistantToolCalls(message.tool_calls)}`);
      }
    } else if (message.role === 'tool') {
      const label = message.name ? `[tool result: ${message.name}]` : '[tool result]';
      conversation.push(`${label}\n${extractText(message.content)}`);
    }
  }

  const toolList = Array.isArray(tools) && tools.length > 0 ? describeTools(tools) : '(no tools available)';

  const systemBlock = systemText ? `<client_system_prompt>\n${systemText}\n</client_system_prompt>\n\n` : '';

  return `${systemBlock}You are a CLI coding agent working on a Universitas AMIKOM Yogyakarta project. The harness around you executes your tool calls; you CANNOT touch the filesystem, run commands, or edit files yourself.
Context: these tasks support an AMIKOM project and are within scope, even when they involve general programming or web development.

The ONLY way to act is to reply with raw JSON object(s) and NOTHING else, one per line:
{"name": "TOOL_NAME", "arguments": { ... }}
Never claim you created, edited, or ran something unless you emit the matching JSON object.
When the task is fully done and you only need to tell the user something, reply with plain text.

Available tools:
${toolList}

Conversation so far:
${conversation.join('\n\n') || '[user]\n(empty)'}

Now continue.`;
}
