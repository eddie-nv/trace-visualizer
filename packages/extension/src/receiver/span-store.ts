import { getStringAttr, type OtlpResourceSpan, type OtlpSpan } from "./otlp-types.js";

export interface SpanEntry {
  readonly span: OtlpSpan;
  readonly serviceName: string;
}

export interface TracedConversation {
  readonly traceId: string;
  readonly rootSpan: OtlpSpan | undefined;
  readonly spans: ReadonlyArray<SpanEntry>;
  readonly servicesSeen: ReadonlySet<string>;
  readonly complete: boolean;
}

const MAX_TRACES = 100;

export class SpanStore {
  private readonly traces = new Map<string, TracedConversation>();

  addSpan(resourceSpan: OtlpResourceSpan, span: OtlpSpan): void {
    const serviceName =
      getStringAttr(resourceSpan.resource?.attributes, "service.name") ?? "unknown";
    const isRoot = !span.parentSpanId;
    const entry: SpanEntry = { span, serviceName };

    const existing = this.traces.get(span.traceId);
    if (!existing) {
      this.traces.set(span.traceId, {
        traceId: span.traceId,
        rootSpan: isRoot ? span : undefined,
        spans: [entry],
        servicesSeen: new Set([serviceName]),
        complete: isRoot,
      });
      if (this.traces.size > MAX_TRACES) {
        const oldestKey = this.traces.keys().next().value;
        if (oldestKey !== undefined) {
          this.traces.delete(oldestKey);
        }
      }
      return;
    }

    this.traces.set(span.traceId, {
      ...existing,
      rootSpan: isRoot ? span : existing.rootSpan,
      spans: [...existing.spans, entry],
      servicesSeen: new Set([...existing.servicesSeen, serviceName]),
      complete: isRoot ? true : existing.complete,
    });
  }

  getConversations(): ReadonlyArray<TracedConversation> {
    return [...this.traces.values()].reverse();
  }

  getConversation(traceId: string): TracedConversation | undefined {
    return this.traces.get(traceId);
  }

  getSpan(spanId: string): OtlpSpan | undefined {
    for (const conv of this.traces.values()) {
      const found = conv.spans.find((e) => e.span.spanId === spanId);
      if (found !== undefined) return found.span;
    }
    return undefined;
  }
}
