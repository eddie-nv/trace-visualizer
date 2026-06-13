/**
 * Test F harness — MCP server + multi-participant live tool call (M12).
 *
 * Prerequisites:
 *   1. AgentGraph VS Code extension is active (OTLP receiver on port 4319)
 *   2. workspace/ai-chatbot is running with AGENTGRAPH_ENDPOINT=http://localhost:4319
 *   3. `npm run build` has produced packages/extension/dist/mcp.js
 *
 * Run:
 *   npm run test:f
 *
 * The harness:
 *   1. Reads the MCP store written by the extension (~/.agentgraph/traces.json)
 *   2. Finds a trace containing a tool call (operation matching "tool" keyword)
 *   3. Asserts F1–F5 criteria via the pure tool functions (no subprocess needed)
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertAgentContextHasFile,
  assertNoExistingArrowsMoved,
  assertSpanHasCodeFunction,
  assertToolColumnAdded,
  assertToolSpanHasTokens,
  type Evidence,
  type McpConversation,
} from "./criteria.ts";
import { readTraces } from "../../packages/extension/src/mcp/ipc-store.ts";
import {
  getAgentContext,
  getConversation,
  getSpan,
  searchTraces,
} from "../../packages/extension/src/mcp/tools.ts";

const MCP_BUILD = fileURLToPath(
  new URL("../../packages/extension/dist/mcp.js", import.meta.url),
);

const TOOL_SERVICE_NAME = process.env["AGENTGRAPH_TOOL_SERVICE"] ?? "getWeather";
const TOOL_KEYWORD = process.env["AGENTGRAPH_TOOL_KEYWORD"] ?? "tool";

async function preflight(): Promise<void> {
  if (!existsSync(MCP_BUILD)) {
    throw new Error(
      "packages/extension/dist/mcp.js is missing — run `npm run build` first",
    );
  }

  const traces = readTraces();
  if (traces.length === 0) {
    throw new Error(
      "No traces in ~/.agentgraph/traces.json — start the extension and run a tool call through the ai-chatbot first",
    );
  }
}

function findToolTrace() {
  const traces = readTraces();
  const matches = searchTraces(traces, TOOL_KEYWORD, 5);
  if (!Array.isArray(matches) || matches.length === 0) {
    throw new Error(
      `No traces matching keyword "${TOOL_KEYWORD}" found — trigger a tool call in ai-chatbot first`,
    );
  }
  return matches[0].traceId;
}

function printReport(evidence: readonly Evidence[]): void {
  console.log("\nTest F verification (M12) — evidence:");
  for (const item of evidence) {
    console.log(`  PASS ${item.criterion} — ${item.detail}`);
  }
}

async function main(): Promise<void> {
  await preflight();

  const traceId = findToolTrace();
  console.log(`Test F: using trace ${traceId}`);

  const traces = readTraces();

  // Build the conversation view
  const convResult = getConversation(traces, traceId);
  if ("error" in convResult) {
    throw new Error(`get_conversation failed: ${convResult.message}`);
  }
  const conv = convResult as McpConversation;

  // Reconstruct "before tool" arrows: all arrows not involving the tool service
  const preToolArrows = {
    arrows: conv.arrows.filter(
      (a) => a.from !== TOOL_SERVICE_NAME && a.to !== TOOL_SERVICE_NAME,
    ),
  };

  // Find the tool span (first arrow TO the tool service)
  const toolArrow = conv.arrows.find((a) => a.to === TOOL_SERVICE_NAME);
  if (!toolArrow) {
    throw new Error(
      `No arrow to tool service "${TOOL_SERVICE_NAME}" found in conversation — check AGENTGRAPH_TOOL_SERVICE env`,
    );
  }
  const spanResult = getSpan(traces, toolArrow.spanId);
  if ("error" in spanResult) {
    throw new Error(`get_span failed: ${spanResult.message}`);
  }

  const agentCtxResult = getAgentContext(traces, TOOL_SERVICE_NAME);
  if ("error" in agentCtxResult) {
    throw new Error(`get_agent_context failed: ${agentCtxResult.message}`);
  }

  const evidence: Evidence[] = [];
  evidence.push(assertToolColumnAdded(conv, TOOL_SERVICE_NAME));
  evidence.push(assertNoExistingArrowsMoved(preToolArrows, conv));
  evidence.push(assertToolSpanHasTokens(spanResult));
  evidence.push(assertSpanHasCodeFunction(spanResult));
  evidence.push(assertAgentContextHasFile(agentCtxResult));

  printReport(evidence);
  console.log("\nTest F PASS: all 5 criteria green");
}

main().catch((error: unknown) => {
  console.error(
    `\nTest F FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
