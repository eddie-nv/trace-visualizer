/**
 * Minimal SSE (`text/event-stream`) parser for the fetch hook's cloned
 * response branch (DESIGN §3 tier 1).
 *
 * Lenient where it keeps data: a final block not terminated by a blank line
 * is still yielded at end-of-stream, so a provider quirk cannot silently drop
 * a trailing usage event.
 */
export interface SseEvent {
  event?: string;
  data: string;
}

const EVENT_BOUNDARY = /\r?\n\r?\n/;
const LINE_BREAK = /\r?\n/;

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = EVENT_BOUNDARY.exec(buffer);
      while (boundary !== null) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const event = parseEventBlock(block);
        if (event !== undefined) {
          yield event;
        }
        boundary = EVENT_BOUNDARY.exec(buffer);
      }
    }
    buffer += decoder.decode();
    const trailing = parseEventBlock(buffer);
    if (trailing !== undefined) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEventBlock(block: string): SseEvent | undefined {
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(LINE_BREAK)) {
    if (line.startsWith("data:")) {
      dataLines.push(stripFieldValue(line, "data:"));
    } else if (line.startsWith("event:")) {
      eventName = stripFieldValue(line, "event:");
    }
    // Comments (":") and other fields (id, retry, …) are ignored per spec.
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  const data = dataLines.join("\n");
  return eventName === undefined ? { data } : { event: eventName, data };
}

function stripFieldValue(line: string, field: string): string {
  const value = line.slice(field.length);
  return value.startsWith(" ") ? value.slice(1) : value;
}
