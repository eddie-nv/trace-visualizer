import * as vscode from "vscode";
import type { WebviewToHostMessage } from "./messages.js";
import type { Fanout } from "../receiver/fanout.js";
import { openSourceLocation } from "../source-locator.js";
import type { SpanStore } from "../receiver/span-store.js";

let activePanel: vscode.WebviewPanel | undefined;

export function getOrCreatePanel(
  context: vscode.ExtensionContext,
  store: SpanStore,
  fanout: Fanout,
): vscode.WebviewPanel {
  if (activePanel) {
    activePanel.reveal();
    return activePanel;
  }

  const panel = vscode.window.createWebviewPanel(
    "agentgraph",
    "AgentGraph",
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "dist"),
        vscode.Uri.joinPath(context.extensionUri, "webview-src"),
      ],
    },
  );

  panel.webview.html = buildHtml(panel.webview, context.extensionUri);
  fanout.setPanel(panel);

  panel.webview.onDidReceiveMessage((raw: unknown) => {
    const msg = raw as WebviewToHostMessage;
    switch (msg.command) {
      case "webviewReady":
        replayTrace(store, fanout);
        fanout.onWebviewReady();
        break;
      case "openFile":
        void openSourceLocation(msg.file, msg.line, msg.fn);
        break;
      default:
        break;
    }
  });

  panel.onDidDispose(() => {
    activePanel = undefined;
  });

  activePanel = panel;
  return panel;
}

function replayTrace(store: SpanStore, fanout: Fanout): void {
  const convs = store.getConversations();
  if (convs.length === 0) return;
  const conv = convs[0];
  if (!conv) return;
  fanout.activateTrace(conv.traceId, conv.spans, conv.complete);
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const nonce = generateNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentGraph</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
    #diagram { width: 100%; height: 100%; padding: 8px; box-sizing: border-box; }
  </style>
</head>
<body>
  <div id="diagram"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function generateNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
