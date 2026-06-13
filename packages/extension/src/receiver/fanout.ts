import type { HostToWebviewMessage } from "../webview/messages.js";
import type { OtlpSpan } from "./otlp-types.js";

interface MinimalWebviewPanel {
  webview: { postMessage(message: unknown): void };
}

export class Fanout {
  private panel: MinimalWebviewPanel | undefined = undefined;
  private ready = false;
  private buffer: HostToWebviewMessage[] = [];

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
    this.enqueue({ command: "appendSpan", traceId, span, serviceName });
  }

  broadcastTraceComplete(traceId: string): void {
    this.enqueue({ command: "traceComplete", traceId });
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
