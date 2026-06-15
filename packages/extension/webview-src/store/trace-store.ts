import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import { spansToViewModel, type SpanEntry } from "./span-classifier.js";
import type { InferredArrow, InferredActionNode, ViewModel } from "./view-model.js";

export type TraceStoreListener = (vm: ViewModel) => void;

export class TraceStore {
  private entries: SpanEntry[] = [];
  private currentTraceId: string | undefined = undefined;
  private listeners: TraceStoreListener[] = [];
  private inferred: ReadonlyArray<InferredArrow | InferredActionNode> = [];

  setActiveTrace(
    traceId: string,
    spans: ReadonlyArray<{ span: OtlpSpan; serviceName: string }>,
  ): void {
    this.currentTraceId = traceId;
    this.entries = [...spans];
    this.inferred = [];
    this.notify();
  }

  applyInferredNodes(nodes: ReadonlyArray<InferredArrow | InferredActionNode>): void {
    this.inferred = nodes;
    this.notify();
  }

  appendSpan(traceId: string, span: OtlpSpan, serviceName: string): void {
    if (traceId !== this.currentTraceId) return;
    this.entries = [...this.entries, { span, serviceName }];
    this.notify();
  }

  getViewModel(): ViewModel {
    const base = spansToViewModel(this.entries);
    if (this.inferred.length === 0) return base;
    const inferredArrows = this.inferred.filter(
      (n): n is InferredArrow => "fromParticipantId" in n,
    );
    const inferredActions = this.inferred.filter(
      (n): n is InferredActionNode => !("fromParticipantId" in n),
    );
    return {
      ...base,
      arrows: [...base.arrows, ...inferredArrows],
      actionNodes: [...base.actionNodes, ...inferredActions],
    };
  }

  subscribe(listener: TraceStoreListener): () => void {
    this.listeners = [...this.listeners, listener];
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notify(): void {
    const vm = this.getViewModel();
    for (const listener of this.listeners) {
      listener(vm);
    }
  }
}
