import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ALLOW_TRACE_CONTENT_KEY, ATTR, withLLMCall } from "@agentgraph/core";

const exporter = new InMemorySpanExporter();

const CHAT_ATTRS = { provider: "anthropic", operation: "chat" } as const;
const REQUEST = {
  model: "claude-sonnet-4-6",
  messages: [{ role: "user", content: "hi" }],
  system: "be brief",
} as const;
const RESPONSE = {
  model: "claude-sonnet-4-6-20250930",
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationInputTokens: 2,
    cacheReadInputTokens: 1,
  },
  messages: [{ role: "assistant", content: "hello" }],
  finishReasons: ["end_turn"],
} as const;

function getSingleFinishedSpan() {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0]!;
}

beforeAll(() => {
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

afterEach(() => {
  exporter.reset();
  vi.unstubAllEnvs();
});

afterAll(() => {
  trace.disable();
  context.disable();
});

describe("withLLMCall", () => {
  it("emits a CLIENT span named '<operation> <model>' with semconv request/response attributes", async () => {
    // Act
    const result = await withLLMCall(CHAT_ATTRS, async (span) => {
      const tracked = span.reportRequest(REQUEST);
      tracked.reportResponse(RESPONSE);
      return "ok";
    });

    // Assert
    expect(result).toBe("ok");
    const span = getSingleFinishedSpan();
    expect(span.name).toBe("chat claude-sonnet-4-6");
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes[ATTR.PROVIDER_NAME]).toBe("anthropic");
    expect(span.attributes[ATTR.OPERATION_NAME]).toBe("chat");
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[ATTR.RESPONSE_MODEL]).toBe("claude-sonnet-4-6-20250930");
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
    expect(span.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBe(2);
    expect(span.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS]).toBe(1);
    expect(JSON.parse(String(span.attributes[ATTR.INPUT_MESSAGES]))).toEqual(REQUEST.messages);
    expect(JSON.parse(String(span.attributes[ATTR.OUTPUT_MESSAGES]))).toEqual(RESPONSE.messages);
  });

  it("wraps a string system prompt as semconv system_instructions parts", async () => {
    await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST);
      return undefined;
    });

    const span = getSingleFinishedSpan();
    expect(JSON.parse(String(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]))).toEqual([
      { type: "text", content: "be brief" },
    ]);
  });

  it("resolves with the callback's return value for synchronous callbacks", async () => {
    const result = await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST);
      return 42;
    });

    expect(result).toBe(42);
  });

  it("makes the LLM span the active span inside the callback", async () => {
    // Arrange
    let activeSpanId: string | undefined;

    // Act
    await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST);
      activeSpanId = trace.getActiveSpan()?.spanContext().spanId;
      return undefined;
    });

    // Assert
    expect(activeSpanId).toBe(getSingleFinishedSpan().spanContext().spanId);
  });

  it("does not expose reportResponse before reportRequest is called", async () => {
    // The staged interface makes report-response-first unrepresentable.
    await withLLMCall(CHAT_ATTRS, (span) => {
      expect((span as unknown as Record<string, unknown>)["reportResponse"]).toBeUndefined();
      span.reportRequest(REQUEST);
      return undefined;
    });
  });

  it("rejects with the original error and marks the span ERROR when the callback throws", async () => {
    // Arrange
    const boom = new Error("boom");

    // Act / Assert
    await expect(
      withLLMCall(CHAT_ATTRS, (span) => {
        span.reportRequest(REQUEST);
        throw boom;
      }),
    ).rejects.toBe(boom);
    const span = getSingleFinishedSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe("boom");
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("rejects and records the exception when the callback returns a rejected promise", async () => {
    const boom = new Error("async boom");

    await expect(
      withLLMCall(CHAT_ATTRS, async (span) => {
        span.reportRequest(REQUEST);
        return Promise.reject(boom);
      }),
    ).rejects.toBe(boom);
    const span = getSingleFinishedSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((event) => event.name === "exception")).toBe(true);
  });

  it("omits the four content attributes when AGENTGRAPH_TRACE_CONTENT is 'false' but keeps metadata", async () => {
    // Arrange
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "false");

    // Act
    await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST).reportResponse(RESPONSE);
      return undefined;
    });

    // Assert — DESIGN §4: drop content, keep "metadata, not content".
    const span = getSingleFinishedSpan();
    expect(span.attributes[ATTR.INPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.SYSTEM_INSTRUCTIONS]).toBeUndefined();
    expect(span.attributes[ATTR.OUTPUT_MESSAGES]).toBeUndefined();
    expect(span.attributes[ATTR.TOOL_DEFINITIONS]).toBeUndefined();
    expect(span.attributes[ATTR.REQUEST_MODEL]).toBe("claude-sonnet-4-6");
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span.attributes[ATTR.RESPONSE_FINISH_REASONS]).toEqual(["end_turn"]);
  });

  it("honors a per-call context-key override that re-enables content", async () => {
    // Arrange
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "false");
    const overrideCtx = context.active().setValue(ALLOW_TRACE_CONTENT_KEY, true);

    // Act
    await context.with(overrideCtx, () =>
      withLLMCall(CHAT_ATTRS, (span) => {
        span.reportRequest(REQUEST).reportResponse(RESPONSE);
        return undefined;
      }),
    );

    // Assert
    const span = getSingleFinishedSpan();
    expect(span.attributes[ATTR.INPUT_MESSAGES]).toBeDefined();
    expect(span.attributes[ATTR.OUTPUT_MESSAGES]).toBeDefined();
  });

  it("flags the span when reportRequest is never called", async () => {
    await withLLMCall(CHAT_ATTRS, () => "no-op");

    const span = getSingleFinishedSpan();
    expect(span.name).toBe("chat");
    expect(span.attributes["agentgraph.warn"]).toBe("reportRequest not called");
  });

  it("throws TypeError without emitting a span when provider is empty", () => {
    expect(() => withLLMCall({ provider: "", operation: "chat" }, () => "x")).toThrow(TypeError);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("throws TypeError without emitting a span for an unknown operation", () => {
    const attrs = { provider: "anthropic", operation: "embeddings" as "chat" };

    expect(() => withLLMCall(attrs, () => "x")).toThrow(TypeError);
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("rejects with TypeError and ends the span when reportRequest gets an empty model", async () => {
    await expect(
      withLLMCall(CHAT_ATTRS, (span) => {
        span.reportRequest({ model: "", messages: [] });
        return undefined;
      }),
    ).rejects.toThrow(TypeError);
    const span = getSingleFinishedSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // The caller DID call reportRequest — a validation failure must not also
    // stamp the misleading never-called warning.
    expect(span.attributes["agentgraph.warn"]).toBeUndefined();
  });

  it("emits no usage attributes when reportResponse omits usage", async () => {
    await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST).reportResponse({ finishReasons: ["end_turn"] });
      return undefined;
    });

    const span = getSingleFinishedSpan();
    expect(span.attributes[ATTR.USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS]).toBeUndefined();
    expect(span.attributes[ATTR.USAGE_CACHE_READ_INPUT_TOKENS]).toBeUndefined();
  });

  it("stamps code.* caller attributes from the call site", async () => {
    await withLLMCall(CHAT_ATTRS, (span) => {
      span.reportRequest(REQUEST);
      return undefined;
    });

    const span = getSingleFinishedSpan();
    expect(typeof span.attributes[ATTR.CODE_FILE]).toBe("string");
    expect(typeof span.attributes[ATTR.CODE_LINE]).toBe("number");
    expect(typeof span.attributes[ATTR.CODE_FUNCTION]).toBe("string");
    // The file must not point at an agentgraph internal.
    expect(String(span.attributes[ATTR.CODE_FILE])).not.toMatch(/\/packages\/core\//);
    expect(String(span.attributes[ATTR.CODE_FILE])).not.toMatch(/@agentgraph\//);
  });
});
