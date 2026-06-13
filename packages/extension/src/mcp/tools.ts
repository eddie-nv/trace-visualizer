import type { OtlpAttribute } from "../receiver/otlp-types.js";
import type { TraceRecord } from "./ipc-store.js";

const NO_TRACES = {
  error: "no_traces",
  message:
    "No traces recorded yet. Open VS Code with the AgentGraph extension and send a request through an instrumented app.",
};

function nanoToMs(nanos: bigint): number {
  return Number(nanos / 1_000_000n);
}

function nanoToIso(nanos: bigint): string {
  if (nanos === 0n) return new Date(0).toISOString();
  return new Date(nanoToMs(nanos)).toISOString();
}

function parseNano(s: string): bigint {
  try {
    return BigInt(s);
  } catch {
    return 0n;
  }
}

function flattenAttributes(
  attrs: OtlpAttribute[] | undefined,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const attr of attrs ?? []) {
    const v = attr.value;
    if (v.stringValue !== undefined) result[attr.key] = v.stringValue;
    else if (v.boolValue !== undefined) result[attr.key] = v.boolValue;
    else if (v.intValue !== undefined) result[attr.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) result[attr.key] = v.doubleValue;
  }
  return result;
}

function getIntAttr(attrs: OtlpAttribute[] | undefined, key: string): number {
  const found = attrs?.find((a) => a.key === key);
  if (!found) return 0;
  const v = found.value;
  return Number(v.intValue ?? v.doubleValue ?? 0);
}

function getStringAttr(attrs: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attrs?.find((a) => a.key === key)?.value?.stringValue;
}

// ---------------------------------------------------------------------------
// get_conversation
// ---------------------------------------------------------------------------

export function getConversation(traces: TraceRecord[], traceId: string) {
  const trace = traces.find((t) => t.traceId === traceId);
  if (!trace) {
    return {
      error: "trace_not_found",
      message: `No trace with id "${traceId}"`,
      hint: "Use list_recent_traces to find valid trace IDs.",
    };
  }

  const sortedSpans = [...trace.spans].sort(
    (a, b) =>
      Number(parseNano(a.span.startTimeUnixNano) - parseNano(b.span.startTimeUnixNano)),
  );

  const participantsOrdered: string[] = [];
  const seen = new Set<string>();
  for (const entry of sortedSpans) {
    if (!seen.has(entry.serviceName)) {
      seen.add(entry.serviceName);
      participantsOrdered.push(entry.serviceName);
    }
  }

  const spanIndex = new Map(trace.spans.map((e) => [e.span.spanId, e]));

  const arrows = sortedSpans
    .filter((e) => e.span.parentSpanId !== undefined)
    .map((e) => {
      const parent = spanIndex.get(e.span.parentSpanId!);
      return {
        from: parent?.serviceName ?? "unknown",
        to: e.serviceName,
        operation: e.span.name,
        spanId: e.span.spanId,
        startTimeUnixNano: e.span.startTimeUnixNano,
      };
    });

  return {
    traceId,
    rootOperation: trace.rootSpan?.name ?? null,
    participants: participantsOrdered,
    arrows,
    complete: trace.complete,
  };
}

// ---------------------------------------------------------------------------
// list_agents
// ---------------------------------------------------------------------------

export function listAgents(traces: TraceRecord[], limit = 20) {
  if (traces.length === 0) return NO_TRACES;

  const agentMap = new Map<
    string,
    { callCount: number; inputTokens: number; outputTokens: number; lastSeenNano: bigint }
  >();

  for (const trace of traces) {
    for (const entry of trace.spans) {
      const existing = agentMap.get(entry.serviceName) ?? {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        lastSeenNano: 0n,
      };
      const endNano = parseNano(entry.span.endTimeUnixNano);
      agentMap.set(entry.serviceName, {
        callCount: existing.callCount + 1,
        inputTokens:
          existing.inputTokens +
          getIntAttr(entry.span.attributes, "gen_ai.usage.input_tokens"),
        outputTokens:
          existing.outputTokens +
          getIntAttr(entry.span.attributes, "gen_ai.usage.output_tokens"),
        lastSeenNano: endNano > existing.lastSeenNano ? endNano : existing.lastSeenNano,
      });
    }
  }

  return [...agentMap.entries()]
    .sort((a, b) => b[1].callCount - a[1].callCount)
    .slice(0, limit)
    .map(([agentId, stats]) => ({
      agentId,
      callCount: stats.callCount,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      lastSeen: nanoToIso(stats.lastSeenNano),
    }));
}

// ---------------------------------------------------------------------------
// get_span
// ---------------------------------------------------------------------------

export function getSpan(traces: TraceRecord[], spanId: string) {
  for (const trace of traces) {
    for (const entry of trace.spans) {
      if (entry.span.spanId === spanId) {
        const startNano = parseNano(entry.span.startTimeUnixNano);
        const endNano = parseNano(entry.span.endTimeUnixNano);
        return {
          spanId: entry.span.spanId,
          traceId: trace.traceId,
          name: entry.span.name,
          service: entry.serviceName,
          parentSpanId: entry.span.parentSpanId ?? null,
          startTimeUnixNano: entry.span.startTimeUnixNano,
          endTimeUnixNano: entry.span.endTimeUnixNano,
          durationMs: nanoToMs(endNano - startNano),
          attributes: flattenAttributes(entry.span.attributes),
        };
      }
    }
  }
  return {
    error: "span_not_found",
    message: `No span with id "${spanId}"`,
    hint: "Use get_conversation to find span IDs within a trace.",
  };
}

// ---------------------------------------------------------------------------
// get_agent_context
// ---------------------------------------------------------------------------

export function getAgentContext(traces: TraceRecord[], agentId: string) {
  const files = new Set<string>();
  const functions = new Set<string>();
  let spanCount = 0;

  for (const trace of traces) {
    for (const entry of trace.spans) {
      if (entry.serviceName !== agentId) continue;
      spanCount++;
      const file =
        getStringAttr(entry.span.attributes, "code.file.path") ??
        getStringAttr(entry.span.attributes, "code.filepath");
      const fn =
        getStringAttr(entry.span.attributes, "code.function.name") ??
        getStringAttr(entry.span.attributes, "code.function");
      if (file) files.add(file);
      if (fn) functions.add(fn);
    }
  }

  if (spanCount === 0) {
    return {
      error: "agent_not_found",
      message: `No spans found for agent "${agentId}"`,
      hint: "Use list_agents to see all observed agent IDs.",
    };
  }

  return {
    agentId,
    spanCount,
    files: [...files],
    functions: [...functions],
  };
}

// ---------------------------------------------------------------------------
// search_traces
// ---------------------------------------------------------------------------

export function searchTraces(traces: TraceRecord[], query: string, limit = 10) {
  const q = query.toLowerCase().trim();
  if (!q) return { error: "empty_query", message: "Provide a non-empty search query." };

  const results: Array<{
    traceId: string;
    rootOperation: string | null;
    matchingSpanCount: number;
    services: string[];
    complete: boolean;
  }> = [];

  for (const trace of traces) {
    let matchCount = 0;
    for (const entry of trace.spans) {
      if (entry.span.name.toLowerCase().includes(q)) {
        matchCount++;
        continue;
      }
      for (const attr of entry.span.attributes ?? []) {
        const val =
          attr.value.stringValue ??
          String(attr.value.intValue ?? attr.value.doubleValue ?? "");
        if (attr.key.toLowerCase().includes(q) || val.toLowerCase().includes(q)) {
          matchCount++;
          break;
        }
      }
    }
    if (matchCount > 0) {
      results.push({
        traceId: trace.traceId,
        rootOperation: trace.rootSpan?.name ?? null,
        matchingSpanCount: matchCount,
        services: [...trace.servicesSeen],
        complete: trace.complete,
      });
    }
  }

  return results.slice(0, limit);
}

// ---------------------------------------------------------------------------
// list_recent_traces
// ---------------------------------------------------------------------------

export function listRecentTraces(traces: TraceRecord[], limit = 10) {
  if (traces.length === 0) return NO_TRACES;

  return traces.slice(0, limit).map((trace) => {
    const timestamps = trace.spans.map((e) => parseNano(e.span.startTimeUnixNano));
    const minNano =
      timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : 0n;
    return {
      traceId: trace.traceId,
      rootOperation: trace.rootSpan?.name ?? null,
      timestamp: nanoToIso(minNano),
      serviceCount: trace.servicesSeen.size,
      spanCount: trace.spans.length,
      complete: trace.complete,
    };
  });
}

// ---------------------------------------------------------------------------
// traces summary resource (auto-injected into system prompt)
// ---------------------------------------------------------------------------

export function buildTracesSummary(traces: TraceRecord[]): string {
  if (traces.length === 0) {
    return [
      "# AgentGraph Live Traces",
      "",
      "No traces recorded yet.",
      "Start an instrumented app with `AGENTGRAPH_ENDPOINT=http://localhost:4319` and send a request.",
    ].join("\n");
  }

  const allServices = new Set<string>();
  const opCounts = new Map<string, number>();
  for (const trace of traces) {
    for (const svc of trace.servicesSeen) allServices.add(svc);
    for (const entry of trace.spans) {
      opCounts.set(entry.span.name, (opCounts.get(entry.span.name) ?? 0) + 1);
    }
  }

  const topOps = [...opCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([op, count]) => `- ${op}: ${count} call(s)`);

  const recent = traces.slice(0, 5).map((t) => {
    const status = t.complete ? "complete" : "in progress";
    return `- \`${t.traceId.slice(0, 8)}\` — ${t.rootSpan?.name ?? "unknown"} — ${t.servicesSeen.size} service(s) — ${status}`;
  });

  return [
    "# AgentGraph Live Traces",
    "",
    `**Active agents/services:** ${allServices.size}`,
    `**Total traces recorded:** ${traces.length}`,
    "",
    "## Top Operations by Call Count",
    ...topOps,
    "",
    "## Last 5 Conversations",
    ...recent,
    "",
    "Use `get_conversation(trace_id)` to see the full sequence for any trace above.",
    "**Note:** Only covers spans observed via OTLP — does not know about non-instrumented code paths.",
  ].join("\n");
}
