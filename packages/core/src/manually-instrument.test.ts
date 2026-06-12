import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTR, instrumentFetch, uninstrumentFetch } from "@agentgraph/core";
import {
  manuallyInstrument,
  resetManualInstrumentationWarnings,
  uninstrumentModule,
} from "./manually-instrument.js";

const exporter = new InMemorySpanExporter();
const realFetch = globalThis.fetch;

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

const ANTHROPIC_PARAMS = {
  model: "claude-sonnet-4-6",
  max_tokens: 1024,
  system: "be brief",
  messages: [{ role: "user", content: "hi" }],
} as const;

const ANTHROPIC_MESSAGE = {
  id: "msg_01",
  type: "message",
  role: "assistant",
  model: "claude-sonnet-4-6-20250930",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
} as const;

/** SDK-shaped stream events: parsed objects, exactly what the wire SSE carries. */
const ANTHROPIC_STREAM_EVENTS = [
  {
    type: "message_start",
    message: {
      id: "msg_01",
      model: "claude-sonnet-4-6-20250930",
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "lo" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
] as const;

const OPENAI_PARAMS = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "hi" }],
} as const;

const OPENAI_COMPLETION = {
  id: "chatcmpl-1",
  model: "gpt-4o-mini-2024-07-18",
  choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
} as const;

const OPENAI_STREAM_CHUNKS = [
  {
    id: "chatcmpl-1",
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
  },
  {
    id: "chatcmpl-1",
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, delta: { content: "lo" } }],
  },
  {
    id: "chatcmpl-1",
    model: "gpt-4o-mini-2024-07-18",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  },
] as const;

const OPENAI_USAGE_CHUNK = {
  id: "chatcmpl-1",
  model: "gpt-4o-mini-2024-07-18",
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
} as const;

interface MockStream {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

function mockStream(events: readonly unknown[]): MockStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

/** Minimal module shape matching @anthropic-ai/sdk: Anthropic.Messages.prototype.create. */
function createAnthropicModule(
  impl?: (params: Record<string, unknown>) => Promise<unknown>,
): Record<string, unknown> {
  class Messages {
    async create(params: Record<string, unknown>): Promise<unknown> {
      if (impl !== undefined) {
        return impl(params);
      }
      return params["stream"] === true ? mockStream(ANTHROPIC_STREAM_EVENTS) : ANTHROPIC_MESSAGE;
    }
  }
  class Anthropic {
    static Messages = Messages;
    readonly messages = new Messages();
  }
  return { Anthropic, default: Anthropic };
}

/** Minimal module shape matching openai: OpenAI.Chat.Completions.prototype.create. */
function createOpenAIModule(): Record<string, unknown> {
  class Completions {
    async create(params: Record<string, unknown>): Promise<unknown> {
      if (params["stream"] !== true) {
        return OPENAI_COMPLETION;
      }
      const withUsage = (params["stream_options"] as Record<string, unknown> | undefined)?.[
        "include_usage"
      ];
      return mockStream(
        withUsage === true ? [...OPENAI_STREAM_CHUNKS, OPENAI_USAGE_CHUNK] : OPENAI_STREAM_CHUNKS,
      );
    }
  }
  class Chat {
    static Completions = Completions;
  }
  class OpenAI {
    static Chat = Chat;
  }
  return { OpenAI, default: OpenAI };
}

type CreateFn = (params: Record<string, unknown>) => Promise<unknown>;

function messagesCreate(module: Record<string, unknown>): CreateFn {
  const cls = (module["Anthropic"] as { Messages: { prototype: { create: CreateFn } } }).Messages;
  const instance = new (cls as unknown as new () => { create: CreateFn })();
  return (params) => instance.create(params);
}

function completionsCreate(module: Record<string, unknown>): CreateFn {
  const chat = (module["OpenAI"] as { Chat: { Completions: new () => { create: CreateFn } } }).Chat;
  const instance = new chat.Completions();
  return (params) => instance.create(params);
}

async function drain(stream: unknown): Promise<unknown[]> {
  const received: unknown[] = [];
  for await (const event of stream as AsyncIterable<unknown>) {
    received.push(event);
  }
  return received;
}

async function waitForSpans(count: number): Promise<ReadableSpan[]> {
  await vi.waitFor(() => {
    expect(exporter.getFinishedSpans().length).toBeGreaterThanOrEqual(count);
  });
  return exporter.getFinishedSpans();
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
  resetManualInstrumentationWarnings();
  vi.restoreAllMocks();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

describe("manuallyInstrument — anthropic non-streaming", () => {
  it("emits one span with request and response attributes", async () => {
    // Arrange
    const module = createAnthropicModule();
    manuallyInstrument("anthropic", module);

    // Act
    const result = await messagesCreate(module)({ ...ANTHROPIC_PARAMS });

    // Assert
    expect(result).toEqual(ANTHROPIC_MESSAGE);
    const [span] = await waitForSpans(1);
    expect(span!.name).toBe("chat claude-sonnet-4-6");
    expect(span!.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
    expect(span!.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span!.attributes[ATTR.RESPONSE_ID]).toBe("msg_01");
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span!.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span!.attributes[ATTR.INPUT_MESSAGES]).toBeDefined();
    expect(span!.attributes[ATTR.OUTPUT_MESSAGES]).toBeDefined();
  });

  it("returns the SDK's resolved value unchanged (identity)", async () => {
    const module = createAnthropicModule(async () => ANTHROPIC_MESSAGE);
    manuallyInstrument("anthropic", module);

    const result = await messagesCreate(module)({ ...ANTHROPIC_PARAMS });

    expect(result).toBe(ANTHROPIC_MESSAGE);
    await waitForSpans(1);
  });

  it("respects traceContent: false (no content attrs, usage intact)", async () => {
    const module = createAnthropicModule();
    manuallyInstrument("anthropic", module, { traceContent: false });

    await messagesCreate(module)({ ...ANTHROPIC_PARAMS });

    const [span] = await waitForSpans(1);
    expect(span!.attributes[ATTR.INPUT_MESSAGES]).toBeUndefined();
    expect(span!.attributes[ATTR.OUTPUT_MESSAGES]).toBeUndefined();
    expect(span!.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("records ERROR and rethrows when the SDK call rejects", async () => {
    const failure = new Error("api down");
    const module = createAnthropicModule(async () => {
      throw failure;
    });
    manuallyInstrument("anthropic", module);

    await expect(messagesCreate(module)({ ...ANTHROPIC_PARAMS })).rejects.toThrow("api down");

    const [span] = await waitForSpans(1);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.events.some((event) => event.name === "exception")).toBe(true);
  });
});

describe("manuallyInstrument — anthropic streaming", () => {
  it("delivers every event to the consumer unchanged and accumulates usage", async () => {
    // Arrange
    const module = createAnthropicModule();
    manuallyInstrument("anthropic", module);

    // Act
    const stream = await messagesCreate(module)({ ...ANTHROPIC_PARAMS, stream: true });
    const received = await drain(stream);

    // Assert — byte-for-byte event passthrough is the tier-2 F6 gate
    expect(received).toEqual([...ANTHROPIC_STREAM_EVENTS]);
    const [span] = await waitForSpans(1);
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span!.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span!.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
  });

  it("ends the span with an ERROR when the stream throws mid-iteration", async () => {
    const module = createAnthropicModule(async () => ({
      async *[Symbol.asyncIterator]() {
        yield ANTHROPIC_STREAM_EVENTS[0];
        throw new Error("stream broke");
      },
    }));
    manuallyInstrument("anthropic", module);

    const stream = await messagesCreate(module)({ ...ANTHROPIC_PARAMS, stream: true });
    await expect(drain(stream)).rejects.toThrow("stream broke");

    const [span] = await waitForSpans(1);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    // partial accumulation still lands
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
  });

  it("ends the span when the consumer stops iterating early", async () => {
    const module = createAnthropicModule();
    manuallyInstrument("anthropic", module);

    const stream = await messagesCreate(module)({ ...ANTHROPIC_PARAMS, stream: true });
    for await (const event of stream as AsyncIterable<unknown>) {
      void event;
      break; // early exit must still end the span
    }

    const [span] = await waitForSpans(1);
    expect(span!.name).toBe("chat claude-sonnet-4-6");
  });
});

describe("tier dedup (DESIGN §3.4)", () => {
  it("emits exactly ONE span when the SDK call internally uses the hooked fetch", async () => {
    // Arrange — tier 1 active
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(ANTHROPIC_MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    instrumentFetch();
    // tier 2 active, with a create() that goes through globalThis.fetch
    const module = createAnthropicModule(async (params) => {
      const response = await globalThis.fetch(ANTHROPIC_URL, {
        method: "POST",
        body: JSON.stringify(params),
      });
      return response.json();
    });
    manuallyInstrument("anthropic", module);

    // Act
    const result = await messagesCreate(module)({ ...ANTHROPIC_PARAMS });

    // Assert — exactly one span, and it is the tier-2 span
    expect(result).toEqual(ANTHROPIC_MESSAGE);
    const spans = await waitForSpans(1);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
    expect(spans[0]!.attributes[ATTR.RESPONSE_ID]).toBe("msg_01");
  });

  it("the fetch hook still traces direct fetch calls outside the wrapper", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(ANTHROPIC_MESSAGE), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    instrumentFetch();
    manuallyInstrument("anthropic", createAnthropicModule());

    await globalThis.fetch(ANTHROPIC_URL, {
      method: "POST",
      body: JSON.stringify(ANTHROPIC_PARAMS),
    });

    const spans = await waitForSpans(1);
    expect(spans).toHaveLength(1);
  });
});

describe("manuallyInstrument — lifecycle", () => {
  it("is idempotent: instrumenting twice wraps once", async () => {
    const module = createAnthropicModule();
    manuallyInstrument("anthropic", module);
    manuallyInstrument("anthropic", module);

    await messagesCreate(module)({ ...ANTHROPIC_PARAMS });

    const spans = await waitForSpans(1);
    expect(spans).toHaveLength(1);
  });

  it("uninstrumentModule restores the original method and stops emitting", async () => {
    const module = createAnthropicModule();
    const before = messagesCreate(module);
    manuallyInstrument("anthropic", module);
    uninstrumentModule("anthropic", module);

    const result = await before({ ...ANTHROPIC_PARAMS });

    expect(result).toEqual(ANTHROPIC_MESSAGE);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("warns once and never throws on an unexpected module shape", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => manuallyInstrument("anthropic", { not: "a module" })).not.toThrow();
    expect(() => manuallyInstrument("anthropic", { not: "a module" })).not.toThrow();

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("manuallyInstrument — openai", () => {
  it("emits one span for non-streaming create", async () => {
    const module = createOpenAIModule();
    manuallyInstrument("openai", module);

    const result = await completionsCreate(module)({ ...OPENAI_PARAMS });

    expect(result).toEqual(OPENAI_COMPLETION);
    const [span] = await waitForSpans(1);
    expect(span!.name).toBe("chat gpt-4o-mini");
    expect(span!.attributes[ATTR.PROVIDER_NAME]).toBe("openai");
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span!.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("captures usage from the final chunk when include_usage is set", async () => {
    const module = createOpenAIModule();
    manuallyInstrument("openai", module);

    const stream = await completionsCreate(module)({
      ...OPENAI_PARAMS,
      stream: true,
      stream_options: { include_usage: true },
    });
    await drain(stream);

    const [span] = await waitForSpans(1);
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span!.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  it("emits the span without usage when the stream carries none (Q3 deferred)", async () => {
    const module = createOpenAIModule();
    manuallyInstrument("openai", module);

    const stream = await completionsCreate(module)({ ...OPENAI_PARAMS, stream: true });
    const received = await drain(stream);

    expect(received).toEqual([...OPENAI_STREAM_CHUNKS]);
    const [span] = await waitForSpans(1);
    expect(span!.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(span!.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["stop"]);
  });
});
