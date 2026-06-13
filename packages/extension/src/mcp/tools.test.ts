import { describe, it, expect } from "vitest";
import {
  getConversation,
  listAgents,
  getSpan,
  getAgentContext,
  searchTraces,
  listRecentTraces,
  buildTracesSummary,
} from "./tools.js";
import type { TraceRecord } from "./ipc-store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSpan(
  overrides: Partial<{
    spanId: string;
    parentSpanId: string;
    name: string;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number } }>;
  }> = {},
) {
  return {
    traceId: "trace-001",
    spanId: overrides.spanId ?? "span-001",
    parentSpanId: overrides.parentSpanId,
    name: overrides.name ?? "http.client.request",
    startTimeUnixNano: overrides.startTimeUnixNano ?? "1000000000",
    endTimeUnixNano: overrides.endTimeUnixNano ?? "2000000000",
    attributes: overrides.attributes ?? [],
  };
}

function makeTrace(overrides: Partial<TraceRecord> = {}): TraceRecord {
  const rootSpan = makeSpan({ spanId: "root-1", name: "chat" });
  const childSpan = makeSpan({
    spanId: "child-1",
    parentSpanId: "root-1",
    name: "tool_call",
    startTimeUnixNano: "1500000000",
    endTimeUnixNano: "1800000000",
  });
  return {
    traceId: "trace-001",
    rootSpan,
    spans: [
      { span: rootSpan, serviceName: "assistant" },
      { span: childSpan, serviceName: "tool-service" },
    ],
    servicesSeen: new Set(["assistant", "tool-service"]),
    complete: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// get_conversation
// ---------------------------------------------------------------------------

describe("getConversation", () => {
  it("returns trace_not_found for unknown id", () => {
    const result = getConversation([makeTrace()], "unknown-id");
    expect(result).toMatchObject({ error: "trace_not_found" });
  });

  it("returns participants in chronological order", () => {
    const trace = makeTrace();
    const result = getConversation([trace], "trace-001");
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.participants).toEqual(["assistant", "tool-service"]);
  });

  it("includes arrows between services", () => {
    const trace = makeTrace();
    const result = getConversation([trace], "trace-001");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.arrows).toHaveLength(1);
    expect(result.arrows[0]).toMatchObject({
      from: "assistant",
      to: "tool-service",
      operation: "tool_call",
      spanId: "child-1",
    });
  });

  it("reports rootOperation and completion status", () => {
    const trace = makeTrace();
    const result = getConversation([trace], "trace-001");
    if ("error" in result) throw new Error("unexpected error");
    expect(result.rootOperation).toBe("chat");
    expect(result.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// list_agents
// ---------------------------------------------------------------------------

describe("listAgents", () => {
  it("returns no_traces sentinel for empty input", () => {
    expect(listAgents([])).toMatchObject({ error: "no_traces" });
  });

  it("aggregates span counts per service", () => {
    const result = listAgents([makeTrace()]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    const assistant = result.find((a) => a.agentId === "assistant");
    const tool = result.find((a) => a.agentId === "tool-service");
    expect(assistant?.callCount).toBe(1);
    expect(tool?.callCount).toBe(1);
  });

  it("accumulates gen_ai token attributes", () => {
    const spanWithTokens = makeSpan({
      spanId: "s1",
      name: "generate",
      attributes: [
        { key: "gen_ai.usage.input_tokens", value: { intValue: 100 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 50 } },
      ],
    });
    const trace: TraceRecord = {
      traceId: "t1",
      rootSpan: spanWithTokens,
      spans: [{ span: spanWithTokens, serviceName: "llm-agent" }],
      servicesSeen: new Set(["llm-agent"]),
      complete: true,
    };
    const result = listAgents([trace]);
    if (!Array.isArray(result)) throw new Error("unexpected");
    expect(result[0]).toMatchObject({
      agentId: "llm-agent",
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it("respects the limit parameter", () => {
    const spans = Array.from({ length: 5 }, (_, i) => ({
      span: makeSpan({ spanId: `s${i}`, name: `op${i}` }),
      serviceName: `agent-${i}`,
    }));
    const trace: TraceRecord = {
      traceId: "t1",
      rootSpan: spans[0]!.span,
      spans,
      servicesSeen: new Set(spans.map((s) => s.serviceName)),
      complete: true,
    };
    const result = listAgents([trace], 3);
    expect(Array.isArray(result) && result.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// get_span
// ---------------------------------------------------------------------------

describe("getSpan", () => {
  it("returns span_not_found for unknown id", () => {
    expect(getSpan([makeTrace()], "nonexistent")).toMatchObject({ error: "span_not_found" });
  });

  it("returns span details by id", () => {
    const result = getSpan([makeTrace()], "root-1");
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.spanId).toBe("root-1");
    expect(result.name).toBe("chat");
    expect(result.service).toBe("assistant");
    expect(typeof result.durationMs).toBe("number");
  });

  it("includes flattened attributes in result", () => {
    const span = makeSpan({
      spanId: "s-attr",
      name: "llm",
      attributes: [{ key: "code.file.path", value: { stringValue: "src/agent.ts" } }],
    });
    const trace: TraceRecord = {
      traceId: "t2",
      rootSpan: span,
      spans: [{ span, serviceName: "svc" }],
      servicesSeen: new Set(["svc"]),
      complete: true,
    };
    const result = getSpan([trace], "s-attr");
    if ("error" in result) throw new Error("unexpected");
    expect(result.attributes["code.file.path"]).toBe("src/agent.ts");
  });

  it("calculates duration in milliseconds", () => {
    const span = makeSpan({
      spanId: "s-dur",
      startTimeUnixNano: "1000000000",
      endTimeUnixNano: "2000000000",
    });
    const trace: TraceRecord = {
      traceId: "t3",
      rootSpan: span,
      spans: [{ span, serviceName: "svc" }],
      servicesSeen: new Set(["svc"]),
      complete: true,
    };
    const result = getSpan([trace], "s-dur");
    if ("error" in result) throw new Error("unexpected");
    expect(result.durationMs).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// get_agent_context
// ---------------------------------------------------------------------------

describe("getAgentContext", () => {
  it("returns agent_not_found for unknown agent", () => {
    expect(getAgentContext([makeTrace()], "ghost")).toMatchObject({ error: "agent_not_found" });
  });

  it("extracts code.file.path and code.function.name attributes", () => {
    const span = makeSpan({
      spanId: "s-ctx",
      name: "handle",
      attributes: [
        { key: "code.file.path", value: { stringValue: "src/handler.ts" } },
        { key: "code.function.name", value: { stringValue: "handleRequest" } },
      ],
    });
    const trace: TraceRecord = {
      traceId: "t4",
      rootSpan: span,
      spans: [{ span, serviceName: "my-agent" }],
      servicesSeen: new Set(["my-agent"]),
      complete: true,
    };
    const result = getAgentContext([trace], "my-agent");
    if ("error" in result) throw new Error("unexpected");
    expect(result.files).toContain("src/handler.ts");
    expect(result.functions).toContain("handleRequest");
    expect(result.spanCount).toBe(1);
  });

  it("deduplicates files and functions across spans", () => {
    const makeAttrSpan = (id: string) =>
      makeSpan({
        spanId: id,
        attributes: [{ key: "code.file.path", value: { stringValue: "src/shared.ts" } }],
      });
    const trace: TraceRecord = {
      traceId: "t5",
      rootSpan: makeAttrSpan("s1"),
      spans: [
        { span: makeAttrSpan("s1"), serviceName: "agt" },
        { span: makeAttrSpan("s2"), serviceName: "agt" },
      ],
      servicesSeen: new Set(["agt"]),
      complete: true,
    };
    const result = getAgentContext([trace], "agt");
    if ("error" in result) throw new Error("unexpected");
    expect(result.files).toEqual(["src/shared.ts"]);
    expect(result.spanCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// search_traces
// ---------------------------------------------------------------------------

describe("searchTraces", () => {
  it("returns empty_query error for blank input", () => {
    expect(searchTraces([makeTrace()], "")).toMatchObject({ error: "empty_query" });
  });

  it("matches on span name", () => {
    const result = searchTraces([makeTrace()], "tool_call");
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result).toHaveLength(1);
    expect(result[0]!.matchingSpanCount).toBe(1);
  });

  it("matches on span attribute value", () => {
    const span = makeSpan({
      spanId: "s-search",
      attributes: [{ key: "gen_ai.system", value: { stringValue: "anthropic" } }],
    });
    const trace: TraceRecord = {
      traceId: "t6",
      rootSpan: span,
      spans: [{ span, serviceName: "svc" }],
      servicesSeen: new Set(["svc"]),
      complete: true,
    };
    const result = searchTraces([trace], "anthropic");
    if (!Array.isArray(result)) throw new Error("unexpected");
    expect(result).toHaveLength(1);
  });

  it("returns empty array when nothing matches", () => {
    const result = searchTraces([makeTrace()], "xyzzy-no-match");
    expect(Array.isArray(result) && result.length).toBe(0);
  });

  it("respects limit", () => {
    const traces = Array.from({ length: 5 }, (_, i) => ({
      ...makeTrace(),
      traceId: `t${i}`,
    }));
    const result = searchTraces(traces, "chat", 2);
    expect(Array.isArray(result) && result.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// list_recent_traces
// ---------------------------------------------------------------------------

describe("listRecentTraces", () => {
  it("returns no_traces sentinel for empty input", () => {
    expect(listRecentTraces([])).toMatchObject({ error: "no_traces" });
  });

  it("returns trace metadata", () => {
    const result = listRecentTraces([makeTrace()]);
    expect(Array.isArray(result)).toBe(true);
    if (!Array.isArray(result)) return;
    expect(result[0]).toMatchObject({
      traceId: "trace-001",
      rootOperation: "chat",
      serviceCount: 2,
      spanCount: 2,
      complete: true,
    });
    expect(typeof result[0]!.timestamp).toBe("string");
  });

  it("respects limit", () => {
    const traces = Array.from({ length: 5 }, (_, i) => ({ ...makeTrace(), traceId: `t${i}` }));
    const result = listRecentTraces(traces, 3);
    expect(Array.isArray(result) && result.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// buildTracesSummary
// ---------------------------------------------------------------------------

describe("buildTracesSummary", () => {
  it("returns empty-state message when no traces", () => {
    const md = buildTracesSummary([]);
    expect(md).toContain("No traces recorded yet");
  });

  it("includes agent count and trace count", () => {
    const md = buildTracesSummary([makeTrace()]);
    expect(md).toContain("2"); // 2 services
    expect(md).toContain("1"); // 1 trace
  });

  it("lists top operations", () => {
    const md = buildTracesSummary([makeTrace()]);
    expect(md).toContain("chat");
    expect(md).toContain("tool_call");
  });

  it("includes recent conversation summaries", () => {
    const md = buildTracesSummary([makeTrace()]);
    expect(md).toContain("trace-00"); // first 8 chars of traceId
  });
});
