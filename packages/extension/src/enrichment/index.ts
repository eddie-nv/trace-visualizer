import type { OutputChannel } from "vscode";
import type { TracedConversation } from "../receiver/span-store.js";
import type { Fanout } from "../receiver/fanout.js";
import type { InferredArrow, InferredActionNode } from "../../webview-src/store/view-model.js";
import { isEnrichmentEnabled } from "./consent-gate.js";
import { findSourceFiles } from "./source-finder.js";
import { buildPrompt } from "./prompt-builder.js";
import { callLlm } from "./llm-client.js";
import type { LlmInferredNode } from "./types.js";

const API_KEY_ENV = "AGENTGRAPH_ANTHROPIC_KEY";

export class EnrichmentEngine {
  async enrich(
    conv: TracedConversation,
    fanout: Fanout,
    outputChannel: OutputChannel,
  ): Promise<void> {
    if (!isEnrichmentEnabled(outputChannel)) return;

    const apiKey = process.env[API_KEY_ENV];
    if (!apiKey) {
      outputChannel.appendLine(
        "[AgentGraph] LLM enrichment skipped: AGENTGRAPH_ANTHROPIC_KEY not set",
      );
      return;
    }

    const sourceFiles = await findSourceFiles(conv.servicesSeen);
    const participantIds = [...conv.servicesSeen];
    const prompt = buildPrompt(conv.spans, sourceFiles, participantIds);

    const llmNodes = await callLlm(apiKey, prompt, outputChannel);
    if (llmNodes === null) return;

    const nodes: ReadonlyArray<InferredArrow | InferredActionNode> = llmNodes.map(mapNode);
    fanout.broadcastInferredNodes(conv.traceId, nodes);

    outputChannel.appendLine(
      `[AgentGraph] LLM enrichment: added ${nodes.length} inferred nodes to trace ${conv.traceId}`,
    );
  }
}

function mapNode(node: LlmInferredNode, i: number): InferredArrow | InferredActionNode {
  if (node.nodeType === "arrow") {
    return {
      kind: "inferred",
      id: `inferred-${i}`,
      fromParticipantId: node.fromParticipantId,
      toParticipantId: node.toParticipantId,
      style: node.style,
      label: node.label,
      timeNs: node.timeNs,
      codePointer: node.codePointer,
      reasoning: node.reasoning,
    };
  }
  return {
    kind: "inferred",
    id: `inferred-${i}`,
    participantId: node.participantId,
    label: node.label,
    timeNs: node.timeNs,
    codePointer: node.codePointer,
    reasoning: node.reasoning,
  };
}
