import { describe, it, expect, beforeEach } from "vitest";
import { SpanStore } from "./span-store.js";
import type { OtlpSpan, OtlpResourceSpan } from "./otlp-types.js";

function makeResourceSpan(serviceName: string): OtlpResourceSpan {
  return {
    resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
    scopeSpans: [],
  };
}

function makeSpan(
  overrides: Partial<OtlpSpan> & Pick<OtlpSpan, "traceId" | "spanId" | "name">,
): OtlpSpan {
  return {
    startTimeUnixNano: "1000000000000",
    endTimeUnixNano: "2000000000000",
    ...overrides,
  };
}

describe("SpanStore", () => {
  let store: SpanStore;

  beforeEach(() => {
    store = new SpanStore();
  });

  it("adds a span to a new trace", () => {
    const resource = makeResourceSpan("my-service");
    const span = makeSpan({ traceId: "abc123", spanId: "s1", name: "op", parentSpanId: "parent0" });
    store.addSpan(resource, span);

    const convs = store.getConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]?.traceId).toBe("abc123");
    expect(convs[0]?.spans).toHaveLength(1);
    expect(convs[0]?.spans[0]?.span.spanId).toBe("s1");
  });

  it("appends subsequent spans to the same trace", () => {
    const resource = makeResourceSpan("svc");
    store.addSpan(resource, makeSpan({ traceId: "t1", spanId: "s1", name: "a", parentSpanId: "p" }));
    store.addSpan(resource, makeSpan({ traceId: "t1", spanId: "s2", name: "b", parentSpanId: "p" }));

    const convs = store.getConversations();
    expect(convs).toHaveLength(1);
    expect(convs[0]?.spans).toHaveLength(2);
  });

  it("detects root span (no parentSpanId) and sets rootSpan", () => {
    const resource = makeResourceSpan("svc");
    const root = makeSpan({ traceId: "t1", spanId: "root", name: "root-op" });
    store.addSpan(resource, root);

    const conv = store.getConversations()[0];
    expect(conv?.rootSpan?.spanId).toBe("root");
  });

  it("marks trace complete when root span arrives", () => {
    const resource = makeResourceSpan("svc");
    store.addSpan(resource, makeSpan({ traceId: "t1", spanId: "child", name: "child", parentSpanId: "root" }));
    expect(store.getConversations()[0]?.complete).toBe(false);

    store.addSpan(resource, makeSpan({ traceId: "t1", spanId: "root", name: "root" }));
    expect(store.getConversations()[0]?.complete).toBe(true);
  });

  it("tracks services seen per trace", () => {
    store.addSpan(makeResourceSpan("svc-a"), makeSpan({ traceId: "t1", spanId: "s1", name: "x", parentSpanId: "r" }));
    store.addSpan(makeResourceSpan("svc-b"), makeSpan({ traceId: "t1", spanId: "s2", name: "y", parentSpanId: "r" }));

    const conv = store.getConversations()[0];
    expect(conv?.servicesSeen.has("svc-a")).toBe(true);
    expect(conv?.servicesSeen.has("svc-b")).toBe(true);
  });

  it("returns conversations most recent first", () => {
    const r = makeResourceSpan("svc");
    store.addSpan(r, makeSpan({ traceId: "older", spanId: "s1", name: "a" }));
    store.addSpan(r, makeSpan({ traceId: "newer", spanId: "s2", name: "b" }));

    const convs = store.getConversations();
    expect(convs[0]?.traceId).toBe("newer");
    expect(convs[1]?.traceId).toBe("older");
  });

  it("drops oldest trace when more than 100 are added", () => {
    const r = makeResourceSpan("svc");
    for (let i = 0; i < 101; i++) {
      store.addSpan(r, makeSpan({ traceId: `trace-${i}`, spanId: `s${i}`, name: "op" }));
    }
    const convs = store.getConversations();
    expect(convs).toHaveLength(100);
    expect(convs.some((c) => c.traceId === "trace-0")).toBe(false);
    expect(convs.some((c) => c.traceId === "trace-100")).toBe(true);
  });

  it("getSpan returns a span by spanId across all traces", () => {
    const r = makeResourceSpan("svc");
    store.addSpan(r, makeSpan({ traceId: "t1", spanId: "s1", name: "a" }));
    store.addSpan(r, makeSpan({ traceId: "t2", spanId: "s2", name: "b" }));

    expect(store.getSpan("s1")?.spanId).toBe("s1");
    expect(store.getSpan("s2")?.spanId).toBe("s2");
    expect(store.getSpan("missing")).toBeUndefined();
  });

  it("getConversation returns a single trace by traceId", () => {
    const r = makeResourceSpan("svc");
    store.addSpan(r, makeSpan({ traceId: "t1", spanId: "s1", name: "a" }));
    store.addSpan(r, makeSpan({ traceId: "t2", spanId: "s2", name: "b" }));

    expect(store.getConversation("t1")?.traceId).toBe("t1");
    expect(store.getConversation("missing")).toBeUndefined();
  });
});
