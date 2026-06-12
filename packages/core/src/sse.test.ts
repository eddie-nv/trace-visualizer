import { describe, expect, it } from "vitest";
import { parseSseStream, type SseEvent } from "./sse.js";

function streamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collectEvents(chunks: readonly string[]): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  for await (const event of parseSseStream(streamFromChunks(chunks))) {
    events.push(event);
  }
  return events;
}

describe("parseSseStream", () => {
  it("parses a single event with event and data fields", async () => {
    const events = await collectEvents(['event: message_start\ndata: {"type":"message_start"}\n\n']);

    expect(events).toEqual([{ event: "message_start", data: '{"type":"message_start"}' }]);
  });

  it("parses multiple events in one chunk", async () => {
    const events = await collectEvents(["data: one\n\ndata: two\n\n"]);

    expect(events).toEqual([{ data: "one" }, { data: "two" }]);
  });

  it("joins multi-line data fields with a newline", async () => {
    const events = await collectEvents(["data: first\ndata: second\n\n"]);

    expect(events).toEqual([{ data: "first\nsecond" }]);
  });

  it("reassembles events split across arbitrary chunk boundaries", async () => {
    // Split mid-field-name and mid-separator to exercise buffering.
    const events = await collectEvents(["event: messa", "ge_delta\ndata: payload\n", "\ndata: tail\n\n"]);

    expect(events).toEqual([{ event: "message_delta", data: "payload" }, { data: "tail" }]);
  });

  it("handles CRLF line endings", async () => {
    const events = await collectEvents(["event: ping\r\ndata: pong\r\n\r\n"]);

    expect(events).toEqual([{ event: "ping", data: "pong" }]);
  });

  it("ignores comment lines and unknown fields", async () => {
    const events = await collectEvents([": keep-alive\nretry: 1000\nid: 7\ndata: payload\n\n"]);

    expect(events).toEqual([{ data: "payload" }]);
  });

  it("yields a trailing event that the stream ends without terminating", async () => {
    // Lenient flush at EOF so provider quirks cannot drop a final usage event.
    const events = await collectEvents(["data: tail"]);

    expect(events).toEqual([{ data: "tail" }]);
  });

  it("skips blocks without data lines", async () => {
    const events = await collectEvents(["event: ping\n\ndata: real\n\n"]);

    expect(events).toEqual([{ data: "real" }]);
  });

  it("preserves data values without a space after the colon", async () => {
    const events = await collectEvents(["data:[DONE]\n\n"]);

    expect(events).toEqual([{ data: "[DONE]" }]);
  });
});
