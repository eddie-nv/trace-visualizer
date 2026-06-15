import * as vscode from "vscode";

const SETTING_KEY = "enableLLMEnrichment";
const ENV_KILL_SWITCH = "AGENTGRAPH_TRACE_CONTENT";

export function isEnrichmentEnabled(outputChannel: vscode.OutputChannel): boolean {
  if (process.env[ENV_KILL_SWITCH]?.toLowerCase() === "false") {
    outputChannel.appendLine(
      "[AgentGraph] LLM enrichment blocked: AGENTGRAPH_TRACE_CONTENT=false",
    );
    return false;
  }

  const config = vscode.workspace.getConfiguration("agentgraph");
  return config.get<boolean>(SETTING_KEY) ?? false;
}
