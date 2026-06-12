import { SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATTR } from "@agentgraph/core";
import { init, shutdown, withAgent, withConversation } from "./index.js";

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  init({ exporter, disableBatch: true, instrumentFetch: false });
});

afterEach(async () => {
  await shutdown();
  vi.restoreAllMocks();
});

function finishedSpan(name: string): ReadableSpan {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (span === undefined) {
    throw new Error(`span ${name} not exported`);
  }
  return span;
}

describe("withAgent", () => {
  it("runs the callback under a `<agentId>.agent` span and returns its value", () => {
    // Act
    const result = withAgent("billing-bot", () => 42);

    // Assert
    expect(result).toBe(42);
    const span = finishedSpan("billing-bot.agent");
    expect(span.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
  });

  it("accepts the object form and stamps conversation id and channel type", () => {
    // Act
    withAgent({ agentId: "billing-bot", conversationId: "conv-1", channelType: "slack" }, () => {
      trace.getTracer("test").startSpan("inner").end();
    });

    // Assert — both the agent span and the nested span are stamped
    for (const name of ["billing-bot.agent", "inner"]) {
      const span = finishedSpan(name);
      expect(span.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
      expect(span.attributes[ATTR.CONVERSATION_ID]).toBe("conv-1");
      expect(span.attributes["gen_ai.conversation.id"]).toBe("conv-1");
      expect(span.attributes[ATTR.CHANNEL_TYPE]).toBe("slack");
    }
  });

  it("parents spans started inside the callback under the agent span", () => {
    withAgent("billing-bot", () => {
      trace.getTracer("test").startSpan("inner").end();
    });

    const agent = finishedSpan("billing-bot.agent");
    const inner = finishedSpan("inner");
    expect(inner.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
  });

  it("supports async callbacks: the agent span ends only after the promise settles", async () => {
    // Act
    const promise = withAgent("billing-bot", async () => {
      await Promise.resolve();
      trace.getTracer("test").startSpan("after-await").end();
      return "done";
    });

    // Assert — agent span still open while the promise is pending
    expect(exporter.getFinishedSpans().some((s) => s.name === "billing-bot.agent")).toBe(false);

    await expect(promise).resolves.toBe("done");
    const span = finishedSpan("billing-bot.agent");
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    // context survives the await (ALS propagation): post-await span is stamped
    expect(finishedSpan("after-await").attributes[ATTR.AGENT_ID]).toBe("billing-bot");
  });

  it("records sync exceptions, marks the span ERROR, and rethrows", () => {
    // Act / Assert
    expect(() =>
      withAgent("billing-bot", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    const span = finishedSpan("billing-bot.agent");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("records async rejections, marks the span ERROR, and rethrows", async () => {
    await expect(
      withAgent("billing-bot", async () => {
        throw new Error("async boom");
      }),
    ).rejects.toThrow("async boom");

    const span = finishedSpan("billing-bot.agent");
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("warns and runs the callback unwrapped when agentId is empty", () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act
    const result = withAgent("", () => 7);

    // Assert — callback still runs, no agent span emitted
    expect(result).toBe(7);
    expect(warn).toHaveBeenCalled();
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe("withConversation", () => {
  it("stamps the conversation id on spans inside without creating its own span", () => {
    // Act
    withConversation("conv-9", () => {
      trace.getTracer("test").startSpan("inner").end();
    });

    // Assert
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["inner"]);
    expect(spans[0]?.attributes[ATTR.CONVERSATION_ID]).toBe("conv-9");
    expect(spans[0]?.attributes["gen_ai.conversation.id"]).toBe("conv-9");
  });

  it("returns the callback value, including async callbacks", async () => {
    expect(withConversation("conv-9", () => "sync")).toBe("sync");
    await expect(withConversation("conv-9", async () => "async")).resolves.toBe("async");
  });

  it("composes with withAgent: agent id and conversation id both stamped", () => {
    withAgent("billing-bot", () => {
      withConversation("conv-9", () => {
        trace.getTracer("test").startSpan("inner").end();
      });
    });

    const inner = finishedSpan("inner");
    expect(inner.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
    expect(inner.attributes[ATTR.CONVERSATION_ID]).toBe("conv-9");
  });
});

describe("withAgent before init", () => {
  it("still runs the callback and returns its value (no provider registered)", async () => {
    // Arrange — tear down the provider from beforeEach
    await shutdown();

    // Act / Assert — must not crash the host app
    expect(withAgent("billing-bot", () => "ok")).toBe("ok");
  });
});
