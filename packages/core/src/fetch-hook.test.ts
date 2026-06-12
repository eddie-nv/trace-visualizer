import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ATTR,
  computeAgentFingerprint,
  instrumentFetch,
  SUPPRESS_FETCH_SPAN_KEY,
  uninstrumentFetch,
} from "@agentgraph/core";

const exporter = new InMemorySpanExporter();
const realFetch = globalThis.fetch;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

const ANTHROPIC_REQUEST_BODY = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  temperature: 0.5,
  top_p: 0.9,
  top_k: 40,
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
} as const;

const ANTHROPIC_RESPONSE_BODY = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6-20250930",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 1,
  },
} as const;

const OPENAI_REQUEST_BODY = {
  model: "gpt-4o-mini",
  max_tokens: 256,
  temperature: 0.2,
  top_p: 0.8,
  frequency_penalty: 0.1,
  presence_penalty: 0.3,
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
  ],
  tools: [{ type: "function", function: { name: "get_weather", parameters: {} } }],
} as const;

const OPENAI_RESPONSE_BODY = {
  id: "chatcmpl-1",
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 3 },
  },
} as const;

const ANTHROPIC_SSE_FIXTURE = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-6-20250930","usage":{"input_tokens":10,"output_tokens":1,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
] as const;

const OPENAI_SSE_FIXTURE = [
  'data: {"id":"chatcmpl-1","model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n',
  'data: {"id":"chatcmpl-1","model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
  'data: {"id":"chatcmpl-1","model":"gpt-4o-mini-2024-07-18","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
] as const;

const OPENAI_SSE_USAGE_CHUNK =
  'data: {"id":"chatcmpl-1","model":"gpt-4o-mini-2024-07-18","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';

const SSE_DONE_CHUNK = "data: [DONE]\n\n";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

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

function sseResponse(chunks: readonly string[]): Response {
  return new Response(streamFromChunks(chunks), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function installFetchMock(impl: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  const mock = vi.fn(impl);
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

async function waitForSingleSpan(): Promise<ReadableSpan> {
  await vi.waitFor(() => {
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });
  return exporter.getFinishedSpans()[0]!;
}

function postJson(url: string, body: unknown): Promise<Response> {
  return globalThis.fetch(url, { method: "POST", body: JSON.stringify(body) });
}

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
  uninstrumentFetch();
  globalThis.fetch = realFetch;
  exporter.reset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

describe("instrumentFetch lifecycle", () => {
  it("patches globalThis.fetch and uninstrumentFetch restores the previous fetch", () => {
    const mock = installFetchMock(async () => jsonResponse({}));

    instrumentFetch();
    expect(globalThis.fetch).not.toBe(mock);

    uninstrumentFetch();
    expect(globalThis.fetch).toBe(mock);
  });

  it("is idempotent — a second instrumentFetch keeps the same wrapper", () => {
    installFetchMock(async () => jsonResponse({}));

    instrumentFetch();
    const wrapper = globalThis.fetch;
    instrumentFetch();

    expect(globalThis.fetch).toBe(wrapper);
  });

  it("warns exactly once when fetch is displaced after instrumentation", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    installFetchMock(async () => jsonResponse({}));
    instrumentFetch();

    const displaced = async () => jsonResponse({});
    globalThis.fetch = displaced as unknown as typeof fetch;
    instrumentFetch();
    instrumentFetch();

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not clobber a displacing fetch on uninstrument", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installFetchMock(async () => jsonResponse({}));
    instrumentFetch();
    const displaced = async () => jsonResponse({});
    globalThis.fetch = displaced as unknown as typeof fetch;

    uninstrumentFetch();

    expect(globalThis.fetch).toBe(displaced);
  });
});

describe("passthrough", () => {
  it("passes non-matching URLs through with identical arguments and response", async () => {
    const upstreamResponse = jsonResponse({ ok: true });
    const mock = installFetchMock(async () => upstreamResponse);
    instrumentFetch();
    const init = { method: "POST", body: '{"x":1}' };

    const response = await globalThis.fetch("https://example.com/v1/messages", init);

    expect(response).toBe(upstreamResponse);
    expect(mock).toHaveBeenCalledExactlyOnceWith("https://example.com/v1/messages", init);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("passes non-POST requests to a provider host through without a span", async () => {
    const mock = installFetchMock(async () => jsonResponse({}));
    instrumentFetch();

    await globalThis.fetch(ANTHROPIC_URL, { method: "GET" });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("passes non-https provider URLs through without a span", async () => {
    const mock = installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();

    await globalThis.fetch("http://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify(ANTHROPIC_REQUEST_BODY),
    });

    expect(mock).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("skips span creation when SUPPRESS_FETCH_SPAN_KEY is set on the active context", async () => {
    const mock = installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();
    const suppressed = context.active().setValue(SUPPRESS_FETCH_SPAN_KEY, true);

    await context.with(suppressed, () => postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY));

    expect(mock).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("anthropic non-streaming", () => {
  it("emits a CLIENT span with request, response, usage, and fingerprint attributes", async () => {
    const upstreamResponse = jsonResponse(ANTHROPIC_RESPONSE_BODY);
    installFetchMock(async () => upstreamResponse);
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    // The caller's response object is the original, byte-identical.
    expect(response).toBe(upstreamResponse);
    expect(await response.json()).toEqual(ANTHROPIC_RESPONSE_BODY);

    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat claude-sonnet-4-6");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
    expect(span.attributes[ATTR.OPERATION_NAME]).toBe("chat");
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[ATTR.REQUEST_MAX_TOKENS]).toBe(1024);
    expect(span.attributes[ATTR.REQUEST_TEMPERATURE]).toBe(0.5);
    expect(span.attributes[ATTR.REQUEST_TOP_P]).toBe(0.9);
    expect(span.attributes[ATTR.REQUEST_TOP_K]).toBe(40);
    expect(span.attributes[ATTR.RESPONSE_ID]).toBe("msg_01");
    expect(span.attributes[ATTR.RESPONSE_MODEL]).toBe("claude-sonnet-4-6-20250930");
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(2);
    expect(span.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(1);
    expect(JSON.parse(String(span.attributes[ATTR.INPUT_MESSAGES]))).toEqual(
      ANTHROPIC_REQUEST_BODY.messages,
    );
    expect(JSON.parse(String(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]))).toEqual([
      { type: "text", content: "be brief" },
    ]);
    expect(JSON.parse(String(span.attributes[ATTR.TOOL_DEFINITIONS]))).toEqual(
      ANTHROPIC_REQUEST_BODY.tools,
    );
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual([
      { role: "assistant", content: ANTHROPIC_RESPONSE_BODY.content },
    ]);
    expect(span.attributes[ATTR.AGENT_FINGERPRINT]).toBe(
      computeAgentFingerprint({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        toolNames: ["get_weather"],
        systemPrompt: "be brief",
      }),
    );
  });

  it("omits optional request params that are absent from the body", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.REQUEST_MAX_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.REQUEST_TEMPERATURE]).toBeUndefined();
    expect(span.attributes[ATTR.REQUEST_TOP_P]).toBeUndefined();
    expect(span.attributes[ATTR.REQUEST_TOP_K]).toBeUndefined();
    expect(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]).toBeUndefined();
    expect(span.attributes[ATTR.TOOL_DEFINITIONS]).toBeUndefined();
  });

  it("supports a Request object as fetch input", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();

    const request = new Request(ANTHROPIC_URL, {
      method: "POST",
      body: JSON.stringify(ANTHROPIC_REQUEST_BODY),
    });
    await globalThis.fetch(request);

    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat claude-sonnet-4-6");
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
  });

  it("drops the four content attributes when AGENTGRAPH_TRACE_CONTENT is 'false'", async () => {
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "false");
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.INPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]).toBeUndefined();
    expect(span.attributes[ATTR.TOOL_DEFINITIONS]).toBeUndefined();
    expect(span.attributes[ATTR.OUTPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
  });

  it("drops content when instrumentFetch is configured with traceContent false", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch({ traceContent: false });

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.INPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.OUTPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("flags the span when the matched request body is not parseable JSON", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();

    await globalThis.fetch(ANTHROPIC_URL, { method: "POST", body: "not json" });

    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat");
    expect(span.attributes["agentgraph.warn"]).toBe("request body not parseable");
    // Response-side attributes are still captured.
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
  });

  it("marks the span ERROR on a non-2xx response and returns the response untouched", async () => {
    const upstreamResponse = jsonResponse(
      { type: "error", error: { type: "overloaded_error" } },
      { status: 529 },
    );
    installFetchMock(async () => upstreamResponse);
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    expect(response).toBe(upstreamResponse);
    const span = await waitForSingleSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
  });

  it("rethrows the exact fetch error and records it on the span", async () => {
    const networkError = new TypeError("fetch failed");
    installFetchMock(async () => {
      throw networkError;
    });
    instrumentFetch();

    await expect(postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY)).rejects.toBe(networkError);

    const span = await waitForSingleSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("serializes an array-form system prompt verbatim into system_instructions", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch();
    const systemParts = [{ type: "text", text: "be brief" }];

    await postJson(ANTHROPIC_URL, {
      model: "claude-sonnet-4-6",
      system: systemParts,
      messages: [{ role: "user", content: "hi" }],
    });

    const span = await waitForSingleSpan();
    expect(JSON.parse(String(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]))).toEqual(systemParts);
  });

  it("flags the span when the response body is not parseable JSON", async () => {
    installFetchMock(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    instrumentFetch();

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes["agentgraph.warn"]).toBe("response body not parseable");
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
  });

  it("emits no response attributes when the response JSON is not an object", async () => {
    installFetchMock(async () => jsonResponse("ok"));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.RESPONSE_ID]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
  });

  it("ends the span without response attributes when the response has no body", async () => {
    installFetchMock(async () => new Response(null, { status: 200 }));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.RESPONSE_ID]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
  });
});

describe("openai non-streaming", () => {
  it("maps max_completion_tokens when max_tokens is absent", async () => {
    installFetchMock(async () => jsonResponse(OPENAI_RESPONSE_BODY));
    instrumentFetch();

    await postJson(OPENAI_URL, {
      model: "gpt-4o-mini",
      max_completion_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.REQUEST_MAX_TOKENS]).toBe(512);
  });

  it("emits a span with OpenAI request/response mapping", async () => {
    installFetchMock(async () => jsonResponse(OPENAI_RESPONSE_BODY));
    instrumentFetch();

    await postJson(OPENAI_URL, OPENAI_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat gpt-4o-mini");
    expect(span.attributes[ATTR.PROVIDER_NAME]).toBe("openai");
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("gpt-4o-mini");
    expect(span.attributes[ATTR.REQUEST_MAX_TOKENS]).toBe(256);
    expect(span.attributes[ATTR.REQUEST_FREQUENCY_PENALTY]).toBe(0.1);
    expect(span.attributes[ATTR.REQUEST_PRESENCE_PENALTY]).toBe(0.3);
    expect(span.attributes[ATTR.RESPONSE_ID]).toBe("chatcmpl-1");
    expect(span.attributes[ATTR.RESPONSE_MODEL]).toBe("gpt-4o-mini-2024-07-18");
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(3);
    expect(JSON.parse(String(span.attributes[ATTR.INPUT_MESSAGES]))).toEqual(
      OPENAI_REQUEST_BODY.messages,
    );
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual([
      { role: "assistant", content: "hello" },
    ]);
    expect(span.attributes[ATTR.AGENT_FINGERPRINT]).toBe(
      computeAgentFingerprint({
        provider: "openai",
        model: "gpt-4o-mini",
        toolNames: ["get_weather"],
        systemPrompt: "be brief",
      }),
    );
  });
});

describe("anthropic streaming", () => {
  it("reconstructs tool_use blocks from input_json_delta events", async () => {
    const toolUseFixture = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_02","model":"claude-sonnet-4-6-20250930","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"get_weather"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"SF\\"}"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
    ];
    installFetchMock(async () => sseResponse(toolUseFixture));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, { ...ANTHROPIC_REQUEST_BODY, stream: true });

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["tool_use"]);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(7);
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_01", name: "get_weather", input: { city: "SF" } }],
      },
    ]);
  });

  it("ignores malformed SSE events and keeps accumulating the rest", async () => {
    const fixtureWithGarbage = [
      "data: this is not json\n\n",
      ...ANTHROPIC_SSE_FIXTURE,
      "data: 42\n\n",
    ];
    installFetchMock(async () => sseResponse(fixtureWithGarbage));
    instrumentFetch();

    await postJson(ANTHROPIC_URL, { ...ANTHROPIC_REQUEST_BODY, stream: true });

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("returns byte-identical SSE to the caller and accumulates usage on the span", async () => {
    const upstreamResponse = sseResponse(ANTHROPIC_SSE_FIXTURE);
    installFetchMock(async () => upstreamResponse);
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, {
      ...ANTHROPIC_REQUEST_BODY,
      stream: true,
    });

    expect(response).toBe(upstreamResponse);
    expect(await response.text()).toBe(ANTHROPIC_SSE_FIXTURE.join(""));

    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat claude-sonnet-4-6");
    expect(span.attributes[ATTR.RESPONSE_ID]).toBe("msg_01");
    expect(span.attributes[ATTR.RESPONSE_MODEL]).toBe("claude-sonnet-4-6-20250930");
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
    // message_start carries initial usage; message_delta overrides output_tokens.
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(2);
    expect(span.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(1);
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual([
      { role: "assistant", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  it("reassembles SSE events split across chunk boundaries", async () => {
    const text = ANTHROPIC_SSE_FIXTURE.join("");
    const midpoint = Math.floor(text.length / 2);
    installFetchMock(async () => sseResponse([text.slice(0, midpoint), text.slice(midpoint)]));
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, { ...ANTHROPIC_REQUEST_BODY, stream: true });

    expect(await response.text()).toBe(text);
    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("marks the span ERROR on a mid-stream failure while the caller sees the same error", async () => {
    const encoder = new TextEncoder();
    // Deliver one chunk, then error on the next pull — erroring in start()
    // would discard the queued chunk per the streams spec.
    let hasDeliveredChunk = false;
    const failingStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (hasDeliveredChunk) {
          controller.error(new Error("connection reset"));
          return;
        }
        hasDeliveredChunk = true;
        controller.enqueue(encoder.encode(ANTHROPIC_SSE_FIXTURE[0]));
      },
    });
    installFetchMock(
      async () =>
        new Response(failingStream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, { ...ANTHROPIC_REQUEST_BODY, stream: true });

    await expect(response.text()).rejects.toThrow("connection reset");
    const span = await waitForSingleSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
    // Note: usage accumulated before the failure is best-effort only — when a
    // teed stream errors, the spec resets branch queues, so chunks our
    // background reader has not yet dequeued are discarded.
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
  });
});

describe("sse stream abuse", () => {
  it("stops parsing an unterminated mega-block while the caller still gets every byte", async () => {
    // > 1 MiB without an SSE delimiter: the parser must bail out instead of
    // buffering (and rescanning) unboundedly; the caller's branch is untouched.
    const megaBlock = "x".repeat(700_000);
    installFetchMock(async () => sseResponse([megaBlock, megaBlock]));
    instrumentFetch();

    const response = await postJson(ANTHROPIC_URL, { ...ANTHROPIC_REQUEST_BODY, stream: true });

    expect(await response.text()).toBe(megaBlock + megaBlock);
    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
  });
});

describe("openai streaming", () => {
  it("emits the span without usage when the stream carries none (Q3 deferred)", async () => {
    installFetchMock(async () => sseResponse([...OPENAI_SSE_FIXTURE, SSE_DONE_CHUNK]));
    instrumentFetch();

    const response = await postJson(OPENAI_URL, { ...OPENAI_REQUEST_BODY, stream: true });

    expect(await response.text()).toBe([...OPENAI_SSE_FIXTURE, SSE_DONE_CHUNK].join(""));
    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.RESPONSE_ID]).toBe("chatcmpl-1");
    expect(span.attributes[ATTR.RESPONSE_MODEL]).toBe("gpt-4o-mini-2024-07-18");
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual([
      { role: "assistant", content: "Hello" },
    ]);
  });

  it("captures usage from the final chunk when include_usage is set", async () => {
    installFetchMock(async () =>
      sseResponse([...OPENAI_SSE_FIXTURE, OPENAI_SSE_USAGE_CHUNK, SSE_DONE_CHUNK]),
    );
    instrumentFetch();

    await postJson(OPENAI_URL, {
      ...OPENAI_REQUEST_BODY,
      stream: true,
      stream_options: { include_usage: true },
    });

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });
});

describe("test match origin override", () => {
  const MOCK_ORIGIN = "http://127.0.0.1:8788";

  it("emits a span for an overridden origin and passes the response through", async () => {
    // Arrange
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch({ testMatchOrigins: { anthropic: MOCK_ORIGIN } });

    // Act
    const response = await postJson(`${MOCK_ORIGIN}/v1/messages`, ANTHROPIC_REQUEST_BODY);

    // Assert
    expect(response.status).toBe(200);
    const span = await waitForSingleSpan();
    expect(span.name).toBe("chat claude-sonnet-4-6");
    expect(span.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
  });

  it("does not trace other paths on the overridden origin", async () => {
    installFetchMock(async () => jsonResponse({ ok: true }));
    instrumentFetch({ testMatchOrigins: { anthropic: MOCK_ORIGIN } });

    const response = await postJson(`${MOCK_ORIGIN}/healthz`, {});
    await response.text();

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("still matches the real provider host while an override is active", async () => {
    installFetchMock(async () => jsonResponse(ANTHROPIC_RESPONSE_BODY));
    instrumentFetch({ testMatchOrigins: { anthropic: MOCK_ORIGIN } });

    await postJson(ANTHROPIC_URL, ANTHROPIC_REQUEST_BODY);

    const span = await waitForSingleSpan();
    expect(span.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
  });
});
