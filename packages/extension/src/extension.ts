import * as vscode from "vscode";
import type { Server } from "node:http";
import { SpanStore } from "./receiver/span-store.js";
import { Fanout } from "./receiver/fanout.js";
import { createOtlpReceiver } from "./receiver/otlp-receiver.js";
import { registerCommands } from "./commands.js";

let server: Server | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const store = new SpanStore();
  const fanout = new Fanout();

  const config = vscode.workspace.getConfiguration("agentgraph");
  const port = config.get<number>("receiverPort") ?? 4319;
  const jaegerEndpoint = config.get<string>("jaegerEndpoint") ?? "";

  const outputChannel = vscode.window.createOutputChannel("AgentGraph");

  server = createOtlpReceiver(store, {
    port,
    jaegerEndpoint: jaegerEndpoint || undefined,
    onSpan: (traceId, span, serviceName) => {
      fanout.broadcastSpan(traceId, span, serviceName);
      const conv = store.getConversation(traceId);
      if (conv?.complete) {
        fanout.broadcastTraceComplete(traceId);
      }
    },
    onError: (err) => {
      outputChannel.appendLine(`[AgentGraph] receiver error: ${err.message}`);
    },
  });

  outputChannel.appendLine(`[AgentGraph] OTLP receiver listening on http://127.0.0.1:${port}/v1/traces`);

  server.on("error", (err: NodeJS.ErrnoException) => {
    const msg =
      err.code === "EADDRINUSE"
        ? `[AgentGraph] Port ${port} is already in use. Change agentgraph.receiverPort in settings.`
        : `[AgentGraph] Receiver failed to start: ${err.message}`;
    outputChannel.appendLine(msg);
    void vscode.window.showErrorMessage(msg);
  });

  registerCommands(context, store, fanout);
  context.subscriptions.push(outputChannel);
}

export function deactivate(): void {
  server?.close();
  server = undefined;
}
