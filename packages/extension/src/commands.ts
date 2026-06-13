import * as vscode from "vscode";
import { getOrCreatePanel } from "./webview/panel.js";
import type { Fanout } from "./receiver/fanout.js";
import type { SpanStore } from "./receiver/span-store.js";

export function registerCommands(
  context: vscode.ExtensionContext,
  store: SpanStore,
  fanout: Fanout,
): void {
  const open = vscode.commands.registerCommand("agentgraph.open", () => {
    getOrCreatePanel(context, store, fanout);
  });
  context.subscriptions.push(open);
}
