import type { HostToWebviewMessage } from "../webview/messages.js";
import type { OtlpSpan } from "./otlp-types.js";
import type { SpanEntry } from "./span-store.js";

interface MinimalWebviewPanel {
  webview: { postMessage(message: unknown): void };
}

export class Fanout {
  private panel: MinimalWebviewPanel | undefined = undefined;
  private ready = false;
  private buffer: HostToWebviewMessage[] = [];
  private activeTraceId: string | undefined = undefined;

  setPanel(panel: MinimalWebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    // Keep buffer — new panel will receive queued spans on webviewReady.
  }

  onWebviewReady(): void {
    this.ready = true;
    for (const msg of this.buffer) {
      this.send(msg);
    }
    this.buffer = [];
  }

  broadcastSpan(traceId: string, span: OtlpSpan, serviceName: string): void {
    if (this.activeTraceId === undefined) {
      this.activeTraceId = traceId;
    }
    if (traceId !== this.activeTraceId) return;
    this.enqueue({ command: "appendSpan", traceId, span, serviceName });
  }

  broadcastTraceComplete(traceId: string): void {
    if (traceId !== this.activeTraceId) return;
    this.enqueue({ command: "traceComplete", traceId });
  }

  /** Switch to a new active trace, clear any buffered messages, and send a full replay. */
  activateTrace(traceId: string, spans: ReadonlyArray<SpanEntry>, complete: boolean): void {
    this.activeTraceId = traceId;
    this.buffer = [];
    this.enqueue({ command: "initTrace", traceId, spans: [...spans] });
    if (complete) {
      this.enqueue({ command: "traceComplete", traceId });
    }
  }

  broadcastThemeChange(kind: "dark" | "light"): void {
    this.enqueue({ command: "themeChange", kind });
  }

  private enqueue(msg: HostToWebviewMessage): void {
    if (!this.panel) return;
    if (!this.ready) {
      this.buffer.push(msg);
      return;
    }
    this.send(msg);
  }

  private send(msg: HostToWebviewMessage): void {
    try {
      this.panel?.webview.postMessage(msg);
    } catch {
      // Panel may have been disposed — never crash the extension.
    }
  }
}
