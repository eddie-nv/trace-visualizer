import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTR } from "@agentgraph/core";
import { forceFlush, init, shutdown } from "./index.js";

// Tier 3 touches real loader hooks — always mocked in unit tests; only the
// env-flag gate is asserted here (the real path is covered in module-hooks.test).
vi.mock("./module-hooks.js", () => ({ activateTier3: vi.fn(() => true) }));

const realFetch = globalThis.fetch;

afterEach(async () => {
  await shutdown();
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function emitSpan(name = "op"): void {
  trace.getTracer("test").startSpan(name).end();
}

describe("init", () => {
  it("installs the fetch hook by default and shutdown() restores it", async () => {
    // Arrange / Act
    init({ exporter: new InMemorySpanExporter(), disableBatch: true });

    // Assert
    expect(globalThis.fetch).not.toBe(realFetch);

    await shutdown();
    expect(globalThis.fetch).toBe(realFetch);
  });

  it("leaves fetch untouched when instrumentFetch is false", () => {
    init({
      exporter: new InMemorySpanExporter(),
      disableBatch: true,
      instrumentFetch: false,
    });

    expect(globalThis.fetch).toBe(realFetch);
  });

  it("routes spans to a custom exporter (escape hatch) and stamps the global agentId", () => {
    // Arrange
    const exporter = new InMemorySpanExporter();
    init({ exporter, disableBatch: true, agentId: "billing-bot", instrumentFetch: false });

    // Act
    emitSpan();

    // Assert
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
  });

  it("reads AGENTGRAPH_AGENT_ID from env when the option is absent", () => {
    // Arrange
    vi.stubEnv("AGENTGRAPH_AGENT_ID", "env-agent");
    const exporter = new InMemorySpanExporter();
    init({ exporter, disableBatch: true, instrumentFetch: false });

    // Act
    emitSpan();

    // Assert
    expect(exporter.getFinishedSpans()[0]?.attributes[ATTR.AGENT_ID]).toBe("env-agent");
  });

  it("batches by default: spans are exported only after forceFlush()", async () => {
    // Arrange — no disableBatch
    const exporter = new InMemorySpanExporter();
    init({ exporter, instrumentFetch: false });

    // Act
    emitSpan();

    // Assert — batch processor holds the span until flush
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await forceFlush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("exports immediately when AGENTGRAPH_DISABLE_BATCH=true", () => {
    vi.stubEnv("AGENTGRAPH_DISABLE_BATCH", "true");
    const exporter = new InMemorySpanExporter();
    init({ exporter, instrumentFetch: false });

    emitSpan();

    expect(exporter.getFinishedSpans()).toHaveLength(1);
  });

  it("appends an additive processor that still sees stamped spans", () => {
    // Arrange
    const extra = new InMemorySpanExporter();
    init({
      exporter: new InMemorySpanExporter(),
      processor: new SimpleSpanProcessor(extra),
      disableBatch: true,
      agentId: "billing-bot",
      instrumentFetch: false,
    });

    // Act
    emitSpan();

    // Assert — the provider fans out to both processors; the stamping
    // processor's onStart ran first, so the additive one sees the attrs
    const spans = extra.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes[ATTR.AGENT_ID]).toBe("billing-bot");
  });

  it("sets the resource service.name from the serviceName option", () => {
    const exporter = new InMemorySpanExporter();
    init({ exporter, disableBatch: true, serviceName: "my-svc", instrumentFetch: false });

    emitSpan();

    expect(exporter.getFinishedSpans()[0]?.resource.attributes["service.name"]).toBe("my-svc");
  });

  it("warns and is a no-op on a second init() call", () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = new InMemorySpanExporter();
    const second = new InMemorySpanExporter();
    init({ exporter: first, disableBatch: true, instrumentFetch: false });

    // Act
    init({ exporter: second, disableBatch: true, instrumentFetch: false });
    emitSpan();

    // Assert — spans still flow to the first provider only
    expect(warn).toHaveBeenCalled();
    expect(first.getFinishedSpans()).toHaveLength(1);
    expect(second.getFinishedSpans()).toHaveLength(0);
  });

  it("allows re-init after shutdown", async () => {
    // Arrange
    const first = new InMemorySpanExporter();
    init({ exporter: first, disableBatch: true, instrumentFetch: false });
    await shutdown();

    // Act
    const second = new InMemorySpanExporter();
    init({ exporter: second, disableBatch: true, instrumentFetch: false });
    emitSpan();

    // Assert
    expect(first.getFinishedSpans()).toHaveLength(0);
    expect(second.getFinishedSpans()).toHaveLength(1);
  });

  it("throws a clear error for an unparseable endpoint", () => {
    expect(() => init({ endpoint: "not a url" })).toThrow(/endpoint/i);
  });

  it("threads traceContent: false into the fetch hook (content gated, metadata kept)", async () => {
    // Arrange — mocked Anthropic endpoint behind the hook
    const exporter = new InMemorySpanExporter();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "msg_01",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "hello" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    init({ exporter, disableBatch: true, traceContent: false });

    // Act
    await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 64,
        messages: [{ role: "user", content: "secret prompt" }],
      }),
    });

    // Assert — span ends after the hook consumes the response body
    await vi.waitFor(() => {
      expect(exporter.getFinishedSpans()).toHaveLength(1);
    });
    const span = exporter.getFinishedSpans()[0];
    // content attrs dropped, usage metadata kept
    expect(span?.attributes[ATTR.INPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[ATTR.OUTPUT_MESSAGES]).toBeUndefined();
    expect(span?.attributes[ATTR.USAGE_INPUT_TOKENS]).toBe(10);
    expect(span?.attributes[ATTR.USAGE_OUTPUT_TOKENS]).toBe(5);
  });
});

describe("forceFlush / shutdown before init", () => {
  it("resolve without throwing and warn instead of crashing the host", async () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act / Assert
    await expect(forceFlush()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

interface MockSdkModule {
  Anthropic: { Messages: { prototype: { create: (...args: unknown[]) => unknown } } };
}

function mockAnthropicModule(): MockSdkModule {
  class Messages {
    async create(): Promise<unknown> {
      return { id: "msg" };
    }
  }
  class Anthropic {
    static Messages = Messages;
  }
  return { Anthropic } as unknown as MockSdkModule;
}

describe("init({instrumentModules}) — tier 2 activation", () => {
  it("wraps provided modules at init and restores them at shutdown", async () => {
    // Arrange
    const module = mockAnthropicModule();
    const original = module.Anthropic.Messages.prototype.create;

    // Act
    init({
      exporter: new InMemorySpanExporter(),
      disableBatch: true,
      instrumentFetch: false,
      instrumentModules: { anthropic: module },
    });

    // Assert
    expect(module.Anthropic.Messages.prototype.create).not.toBe(original);

    await shutdown();
    expect(module.Anthropic.Messages.prototype.create).toBe(original);
  });

  it("a failing module shape does not break init (warn, keep tracing)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    init({
      exporter: new InMemorySpanExporter(),
      disableBatch: true,
      instrumentFetch: false,
      instrumentModules: { anthropic: { wrong: "shape" } },
    });

    expect(warn).toHaveBeenCalled();
    expect(trace.getTracer("test")).toBeDefined();
  });
});

describe("tier-3 gating (AGENTGRAPH_INSTRUMENT_SDKS)", () => {
  it("does not activate module hooks by default", async () => {
    const { activateTier3 } = await import("./module-hooks.js");
    vi.mocked(activateTier3).mockClear();

    init({ exporter: new InMemorySpanExporter(), disableBatch: true, instrumentFetch: false });

    expect(activateTier3).not.toHaveBeenCalled();
  });

  it("activates module hooks when the env flag is the literal 'true'", async () => {
    const { activateTier3 } = await import("./module-hooks.js");
    vi.mocked(activateTier3).mockClear();
    vi.stubEnv("AGENTGRAPH_INSTRUMENT_SDKS", "true");

    init({ exporter: new InMemorySpanExporter(), disableBatch: true, instrumentFetch: false });

    expect(activateTier3).toHaveBeenCalledTimes(1);
  });
});
