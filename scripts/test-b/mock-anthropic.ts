/**
 * Deterministic local stand-in for `POST api.anthropic.com/v1/messages`
 * (Test B, DESIGN §6). Same wire format as the fixtures validated in M2
 * (FINDINGS §4), fixed ids/usage/text so responses are byte-reproducible —
 * the property the live API cannot provide and criterion 4 requires.
 *
 * Streaming usage is deliberately staged the way Anthropic stages it:
 * `message_start` carries input_tokens and a placeholder output count, the
 * final `message_delta` carries the real output_tokens — so criterion 2
 * (streaming usage == non-streaming usage) exercises real accumulation.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const MOCK_USAGE = { input_tokens: 17, output_tokens: 42 } as const;
export const MOCK_JSON_MESSAGE_ID = "msg_mock_json_001";
export const MOCK_STREAM_MESSAGE_ID = "msg_mock_stream_001";
export const MOCK_TOOL_MESSAGE_ID = "msg_mock_tool_001";
export const MOCK_FINAL_MESSAGE_ID = "msg_mock_final_001";
export const MOCK_TOOL_USE_ID = "toolu_mock_001";
export const MOCK_TOOL_NAME = "getWeather";
export const MOCK_STOP_REASON = "end_turn";
export const MOCK_REPLY_TEXT = "Hello from the deterministic mock.";

const STREAM_CHUNK_DELAY_MS = 5;
const TEXT_DELTAS = ["Hello from ", "the deterministic ", "mock."] as const;
const TOOL_INPUT_DELTAS = ['{"city":"San', ' Francisco"}'] as const;

/**
 * The mock's three streaming scripts (M7 Test A-lite needs a tool turn):
 * - "text": the original fixed reply — Test B's byte-stable scenario.
 * - "tool-call": the request carries tool definitions and no tool result yet
 *   → a getWeather tool_use block ending in stop_reason "tool_use".
 * - "final-after-tool": the conversation already contains a tool_result
 *   → the fixed reply again, under its own message id.
 * Order matters: tools stay attached on the follow-up request, so the
 * tool_result check must run first.
 */
type Scenario = "text" | "tool-call" | "final-after-tool";

function detectScenario(body: Record<string, unknown>): Scenario {
  if (hasToolResult(body["messages"])) {
    return "final-after-tool";
  }
  if (Array.isArray(body["tools"]) && body["tools"].length > 0) {
    return "tool-call";
  }
  return "text";
}

function hasToolResult(messages: unknown): boolean {
  if (!Array.isArray(messages)) {
    return false;
  }
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }
    const content = (message as Record<string, unknown>)["content"];
    return (
      Array.isArray(content) &&
      content.some(
        (block) =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>)["type"] === "tool_result",
      )
    );
  });
}

export interface MockAnthropicServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function startMockAnthropic(): Promise<MockAnthropicServer> {
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock-anthropic: could not determine listen port");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST" || req.url !== "/v1/messages") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    const body = await readJsonBody(req);
    const model = typeof body["model"] === "string" ? body["model"] : "claude-mock";
    if (body["stream"] === true) {
      await respondStreaming(res, model, detectScenario(body));
    } else {
      // Non-streaming tool turns are not needed by any harness leg (the AI
      // SDK always streams); the JSON path stays the fixed text reply.
      respondJson(res, model);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`mock-anthropic: request failed: ${detail}`);
    if (res.headersSent) {
      // Mid-stream failure: never inject error JSON into a started SSE body —
      // killing the socket is the only honest signal left.
      res.destroy();
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: detail }));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function respondJson(res: ServerResponse, model: string): void {
  const message = {
    id: MOCK_JSON_MESSAGE_ID,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_REPLY_TEXT }],
    stop_reason: MOCK_STOP_REASON,
    stop_sequence: null,
    usage: MOCK_USAGE,
  };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(message));
}

async function respondStreaming(
  res: ServerResponse,
  model: string,
  scenario: Scenario,
): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const event of streamEventsFor(scenario, model)) {
    if (res.writableEnded || res.destroyed) {
      return; // client went away mid-stream; writing now would throw
    }
    res.write(`event: ${event["type"] as string}\ndata: ${JSON.stringify(event)}\n\n`);
    // A small pause forces multiple reads through the hook's teed branch,
    // exercising the chunk-boundary cases criterion 4 exists to catch.
    await sleep(STREAM_CHUNK_DELAY_MS);
  }
  res.end();
}

function streamEventsFor(
  scenario: Scenario,
  model: string,
): ReadonlyArray<Record<string, unknown>> {
  if (scenario === "tool-call") {
    return toolCallEvents(model);
  }
  return textEvents(model, scenario === "text" ? MOCK_STREAM_MESSAGE_ID : MOCK_FINAL_MESSAGE_ID);
}

function textEvents(model: string, messageId: string): ReadonlyArray<Record<string, unknown>> {
  return [
    messageStartEvent(messageId, model),
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...TEXT_DELTAS.map((text) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: MOCK_STOP_REASON, stop_sequence: null },
      usage: { output_tokens: MOCK_USAGE.output_tokens },
    },
    { type: "message_stop" },
  ];
}

function toolCallEvents(model: string): ReadonlyArray<Record<string, unknown>> {
  return [
    messageStartEvent(MOCK_TOOL_MESSAGE_ID, model),
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: MOCK_TOOL_USE_ID, name: MOCK_TOOL_NAME, input: {} },
    },
    ...TOOL_INPUT_DELTAS.map((partialJson) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: partialJson },
    })),
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: MOCK_USAGE.output_tokens },
    },
    { type: "message_stop" },
  ];
}

function messageStartEvent(messageId: string, model: string): Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: MOCK_USAGE.input_tokens, output_tokens: 1 },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
