import * as vscode from "vscode";
import type { SpanStore, TracedConversation } from "../receiver/span-store.js";
import type { Fanout } from "../receiver/fanout.js";

type SidebarMessage = { command: "selectTrace"; traceId: string };

export class TraceSidebarProvider implements vscode.WebviewViewProvider {
  static readonly VIEW_TYPE = "agentgraph.traceList";

  private view: vscode.WebviewView | undefined = undefined;

  constructor(
    private readonly store: SpanStore,
    private readonly fanout: Fanout,
    private readonly openDiagram: () => void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    this.render();

    webviewView.webview.onDidReceiveMessage((msg: SidebarMessage) => {
      if (msg.command !== "selectTrace") return;
      const conv = this.store.getConversation(msg.traceId);
      if (!conv) return;
      this.fanout.activateTrace(conv.traceId, conv.spans, conv.complete);
      this.openDiagram();
    });
  }

  refresh(): void {
    this.render();
  }

  private render(): void {
    if (!this.view) return;
    this.view.webview.html = buildHtml(this.store.getConversations());
  }
}

function buildHtml(convs: ReadonlyArray<TracedConversation>): string {
  const items = convs
    .map((c) => {
      const name = c.rootSpan?.name ?? c.traceId.slice(0, 8);
      const svcCount = c.servicesSeen.size;
      const status = c.complete ? "&#10003;" : "&#8859;";
      return `<li class="trace-item" data-trace-id="${escapeAttr(c.traceId)}">
        <span class="status">${status}</span>
        <span class="name">${escapeHtml(name)}</span>
        <span class="meta">${svcCount} svc</span>
      </li>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <style>
    body { margin: 0; padding: 4px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); }
    ul { list-style: none; margin: 0; padding: 0; }
    .trace-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; cursor: pointer; border-radius: 3px; user-select: none; }
    .trace-item:hover { background: var(--vscode-list-hoverBackground); }
    .status { flex-shrink: 0; width: 14px; font-size: 11px; }
    .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { flex-shrink: 0; font-size: 11px; opacity: 0.7; }
    .empty { padding: 8px; opacity: 0.6; font-style: italic; }
  </style>
</head>
<body>
  ${convs.length === 0 ? '<p class="empty">No traces received yet.</p>' : `<ul>${items}</ul>`}
  <script>
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('.trace-item').forEach(el => {
      el.addEventListener('click', () => {
        vscode.postMessage({ command: 'selectTrace', traceId: el.dataset.traceId });
      });
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
