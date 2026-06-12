import { context, createContextKey, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ATTR } from "@agentgraph/core";
import { AGENT_ID_KEY, CHANNEL_TYPE_KEY, CONVERSATION_ID_KEY } from "./context-api.js";
import { StampingSpanProcessor } from "./stamping-processor.js";

const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();
let provider: BasicTracerProvider;

beforeAll(() => {
  contextManager.enable();
  context.setGlobalContextManager(contextManager);
  provider = new BasicTracerProvider({
    spanProcessors: [
      new StampingSpanProcessor(new SimpleSpanProcessor(exporter), { agentId: "global-agent" }),
    ],
  });
  trace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
  context.disable();
});

afterEach(() => {
  exporter.reset();
  vi.restoreAllMocks();
});

function emitSpan(name = "op"): ReadableSpan {
  trace.getTracer("test").startSpan(name).end();
  const span = exporter.getFinishedSpans().at(-1);
  if (span === undefined) {
    throw new Error("no span exported");
  }
  return span;
}

describe("StampingSpanProcessor", () => {
  it("stamps agentgraph.* from the active context keys onto started spans", () => {
    // Arrange
    const ctx = context
      .active()
      .setValue(AGENT_ID_KEY, "billing-bot")
      .setValue(CONVERSATION_ID_KEY, "conv-1")
      .setValue(CHANNEL_TYPE_KEY, "slack");

    // Act
    const span = context.with(ctx, () => emitSpan());

    // Assert
    expect(span.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
    expect(span.attributes[ATTR.CONVERSATION_ID]).toBe("conv-1");
    expect(span.attributes[ATTR.CHANNEL_TYPE]).toBe("slack");
  });

  it("also emits standard gen_ai.conversation.id with the same value (DESIGN §2.2)", () => {
    const ctx = context.active().setValue(CONVERSATION_ID_KEY, "conv-1");

    const span = context.with(ctx, () => emitSpan());

    expect(span.attributes["gen_ai.conversation.id"]).toBe("conv-1");
    expect(span.attributes[ATTR.CONVERSATION_ID]).toBe("conv-1");
  });

  it("falls back to the global agentId when no context key is present", () => {
    const span = emitSpan();

    expect(span.attributes[ATTR.AGENT_ID]).toBe("global-agent");
    expect(span.attributes[ATTR.CONVERSATION_ID]).toBeUndefined();
    expect(span.attributes[ATTR.CHANNEL_TYPE]).toBeUndefined();
  });

  it("prefers the context-key agentId over the global fallback", () => {
    const ctx = context.active().setValue(AGENT_ID_KEY, "ctx-agent");

    const span = context.with(ctx, () => emitSpan());

    expect(span.attributes[ATTR.AGENT_ID]).toBe("ctx-agent");
  });

  it("stamps every span started inside the context, including nested children", () => {
    // Arrange
    const ctx = context.active().setValue(AGENT_ID_KEY, "billing-bot");
    const tracer = trace.getTracer("test");

    // Act
    context.with(ctx, () => {
      tracer.startActiveSpan("parent", (parent) => {
        tracer.startActiveSpan("child", (child) => {
          child.end();
        });
        parent.end();
      });
    });

    // Assert
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
    }
  });

  it("does not overwrite an explicitly set agentgraph attribute", () => {
    // Arrange — span started with its own agent id attribute
    const ctx = context.active().setValue(AGENT_ID_KEY, "ctx-agent");

    // Act
    context.with(ctx, () => {
      trace
        .getTracer("test")
        .startSpan("op", { attributes: { [ATTR.AGENT_ID]: "explicit" } })
        .end();
    });

    // Assert
    const span = exporter.getFinishedSpans().at(-1);
    expect(span?.attributes[ATTR.AGENT_ID]).toBe("explicit");
  });

  it("delegates onEnd/forceFlush/shutdown to the wrapped processor", async () => {
    // Arrange
    const inner = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    };
    const stamping = new StampingSpanProcessor(inner, {});

    // Act
    await stamping.forceFlush();
    await stamping.shutdown();

    // Assert
    expect(inner.forceFlush).toHaveBeenCalledOnce();
    expect(inner.shutdown).toHaveBeenCalledOnce();
  });

  it("ignores non-string context values instead of stamping garbage", () => {
    const bogus = context
      .active()
      .setValue(AGENT_ID_KEY, 42)
      .setValue(CONVERSATION_ID_KEY, { id: "x" });

    const span = context.with(bogus, () => emitSpan());

    expect(span.attributes[ATTR.AGENT_ID]).toBe("global-agent");
    expect(span.attributes[ATTR.CONVERSATION_ID]).toBeUndefined();
  });
});

describe("context keys", () => {
  it("are distinct symbols", () => {
    const other = createContextKey("agentgraph.agent_id");
    const keys = [AGENT_ID_KEY, CONVERSATION_ID_KEY, CHANNEL_TYPE_KEY, other];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
