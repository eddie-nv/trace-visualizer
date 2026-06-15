import { describe, it, expect, vi } from "vitest";
import { TraceStore } from "./trace-store.js";
import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import type { InferredArrow, InferredActionNode } from "./view-model.js";

function makeSpan(spanId: string, traceId = "t1", parentSpanId?: string): OtlpSpan {
  return {
    traceId,
    spanId,
    name: `op-${spanId}`,
    startTimeUnixNano: "1000",
    endTimeUnixNano: "2000",
    parentSpanId,
  };
}

describe("TraceStore", () => {
  it("notifies subscriber with empty ViewModel on setActiveTrace with no spans", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTrace("t1", []);

    expect(listener).toHaveBeenCalledOnce();
    const vm = listener.mock.calls[0][0];
    expect(vm.participants).toHaveLength(0);
    expect(vm.arrows).toHaveLength(0);
  });

  it("setActiveTrace replaces existing entries and notifies", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTrace("t1", [{ span: makeSpan("s1"), serviceName: "svc" }]);
    store.setActiveTrace("t2", []);

    expect(listener).toHaveBeenCalledTimes(2);
    const vm2 = listener.mock.calls[1][0];
    expect(vm2.participants).toHaveLength(0);
  });

  it("appendSpan adds span for matching traceId and notifies", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTrace("t1", []);
    store.appendSpan("t1", makeSpan("s1"), "svc");

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("appendSpan is ignored for non-active traceId", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTrace("t1", []);
    listener.mockClear();

    store.appendSpan("t2", makeSpan("s1"), "svc"); // wrong traceId

    expect(listener).not.toHaveBeenCalled();
  });

  it("getViewModel returns classified ViewModel from current entries", () => {
    const store = new TraceStore();
    const span = makeSpan("s1");
    store.setActiveTrace("t1", [{ span, serviceName: "my-svc" }]);

    const vm = store.getViewModel();
    expect(vm.participants).toHaveLength(1);
    expect(vm.participants[0]?.label).toBe("my-svc");
  });

  it("subscribe returns an unsubscribe function that stops notifications", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setActiveTrace("t1", []);
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    store.setActiveTrace("t2", []);
    expect(listener).toHaveBeenCalledOnce(); // no second call
  });

  it("multiple subscribers all receive notifications", () => {
    const store = new TraceStore();
    const l1 = vi.fn();
    const l2 = vi.fn();
    store.subscribe(l1);
    store.subscribe(l2);

    store.setActiveTrace("t1", []);

    expect(l1).toHaveBeenCalledOnce();
    expect(l2).toHaveBeenCalledOnce();
  });

  it("appendSpan accumulates spans so subsequent renders include all", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setActiveTrace("t1", [{ span: makeSpan("s1"), serviceName: "svc" }]);
    store.appendSpan("t1", makeSpan("s2"), "svc");

    const lastVm = listener.mock.calls[listener.mock.calls.length - 1][0];
    expect(lastVm.actionNodes).toHaveLength(2);
  });

  it("applyInferredNodes notifies subscribers", () => {
    const store = new TraceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setActiveTrace("t1", []);
    listener.mockClear();

    store.applyInferredNodes([]);

    expect(listener).toHaveBeenCalledOnce();
  });

  it("applyInferredNodes merges inferred arrows into getViewModel result", () => {
    const store = new TraceStore();
    store.setActiveTrace("t1", []);

    const inferredArrow: InferredArrow = {
      kind: "inferred",
      id: "i1",
      fromParticipantId: "svc-a",
      toParticipantId: "svc-b",
      style: "solid",
      label: "call",
      timeNs: "1000",
      codePointer: { file: "f.ts", line: 1 },
      reasoning: "r",
    };

    store.applyInferredNodes([inferredArrow]);

    const vm = store.getViewModel();
    expect(vm.arrows.some((a) => a.kind === "inferred")).toBe(true);
  });

  it("applyInferredNodes merges inferred action nodes into getViewModel result", () => {
    const store = new TraceStore();
    store.setActiveTrace("t1", []);

    const inferredAction: InferredActionNode = {
      kind: "inferred",
      id: "i1",
      participantId: "svc-a",
      label: "process",
      timeNs: "1000",
      codePointer: { file: "agent.ts", line: 5 },
      reasoning: "logic",
    };

    store.applyInferredNodes([inferredAction]);

    const vm = store.getViewModel();
    expect(vm.actionNodes.some((n) => n.kind === "inferred")).toBe(true);
  });

  it("setActiveTrace resets inferred nodes from previous trace", () => {
    const store = new TraceStore();
    store.setActiveTrace("t1", []);

    const inferredArrow: InferredArrow = {
      kind: "inferred",
      id: "i1",
      fromParticipantId: "svc-a",
      toParticipantId: "svc-b",
      style: "solid",
      label: "call",
      timeNs: "1000",
      codePointer: { file: "f.ts", line: 1 },
      reasoning: "r",
    };
    store.applyInferredNodes([inferredArrow]);

    store.setActiveTrace("t2", []);

    const vm = store.getViewModel();
    expect(vm.arrows.filter((a) => a.kind === "inferred")).toHaveLength(0);
  });

  it("getViewModel returns base ViewModel when no inferred nodes applied", () => {
    const store = new TraceStore();
    store.setActiveTrace("t1", []);

    const vm = store.getViewModel();
    expect(vm.arrows).toHaveLength(0);
    expect(vm.actionNodes).toHaveLength(0);
  });
});
