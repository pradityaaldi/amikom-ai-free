/**
 * Minimal, dependency free Server-Sent Events parser.
 *
 * The AMIKOM backend emits `event:` + `data:` blocks separated by a blank line.
 * This parser is tolerant of CRLF line endings and multi-line `data:` fields.
 */

function parseBlock(block) {
  let event = 'message';
  const dataLines = [];

  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const parsed = parseBlock(block);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode().replace(/\r\n/g, '\n');
    for (const block of buffer.split('\n\n')) {
      const parsed = parseBlock(block);
      if (parsed) yield parsed;
    }
  } finally {
    reader.releaseLock?.();
  }
}
