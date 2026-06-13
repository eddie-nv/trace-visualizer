import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import { spansToViewModel, type SpanEntry } from "./span-classifier.js";
import type { ViewModel } from "./view-model.js";

export type TraceStoreListener = (vm: ViewModel) => void;

export class TraceStore {
  private entries: SpanEntry[] = [];
  private currentTraceId: string | undefined = undefined;
  private listeners: TraceStoreListener[] = [];

  setActiveTrace(traceId: string, spans: ReadonlyArray<{ span: OtlpSpan; serviceName: string }>): void {
    this.currentTraceId = traceId;
    this.entries = [...spans];
    this.notify();
  }

  appendSpan(traceId: string, span: OtlpSpan, serviceName: string): void {
    if (traceId !== this.currentTraceId) return;
    this.entries = [...this.entries, { span, serviceName }];
    this.notify();
  }

  getViewModel(): ViewModel {
    return spansToViewModel(this.entries);
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
