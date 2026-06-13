#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readTraces } from "./ipc-store.js";
import {
  buildTracesSummary,
  getAgentContext,
  getConversation,
  getSpan,
  listAgents,
  listRecentTraces,
  searchTraces,
} from "./tools.js";

const server = new McpServer({
  name: "agentgraph",
  version: "0.1.0",
});

// ---------------------------------------------------------------------------
// Resource: auto-injected markdown digest
// ---------------------------------------------------------------------------

server.resource(
  "traces-summary",
  "agentgraph://traces/summary",
  {
    description:
      "Live markdown digest of all observed agents, services, and conversations. Auto-included in context.",
  },
  async () => ({
    contents: [
      {
        uri: "agentgraph://traces/summary",
        mimeType: "text/markdown",
        text: buildTracesSummary(readTraces()),
      },
    ],
  }),
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.tool(
  "get_conversation",
  "Get the full sequence for a trace: participants, ordered arrows, and action nodes. ONLY covers spans observed via OTLP — does not know about non-instrumented code paths.",
  {
    trace_id: z.string().describe("Trace ID from list_recent_traces"),
  },
  async ({ trace_id }) => ({
    content: [
      { type: "text", text: JSON.stringify(getConversation(readTraces(), trace_id), null, 2) },
    ],
  }),
);

server.tool(
  "list_agents",
  "List all participants (agents/services) seen across observed traces, with span counts and token totals.",
  {
    limit: z
      .number()
      .optional()
      .default(20)
      .describe("Max agents to return (default 20)"),
  },
  async ({ limit }) => ({
    content: [
      { type: "text", text: JSON.stringify(listAgents(readTraces(), limit), null, 2) },
    ],
  }),
);

server.tool(
  "get_span",
  "Get all attributes for a specific span — operationName, service, duration, tokens, and code.* source location.",
  {
    span_id: z.string().describe("Span ID from get_conversation arrows"),
  },
  async ({ span_id }) => ({
    content: [
      { type: "text", text: JSON.stringify(getSpan(readTraces(), span_id), null, 2) },
    ],
  }),
);

server.tool(
  "get_agent_context",
  "Get files and functions touched by spans for a specific agent/service (requires code.* attributes on spans).",
  {
    agent_id: z.string().describe("Agent/service name from list_agents"),
  },
  async ({ agent_id }) => ({
    content: [
      { type: "text", text: JSON.stringify(getAgentContext(readTraces(), agent_id), null, 2) },
    ],
  }),
);

server.tool(
  "search_traces",
  "Search traces whose span operation names or attributes contain the given keywords.",
  {
    query: z.string().describe("Search keywords (e.g. 'chat', 'tool_call', 'getWeather')"),
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max results to return (default 10)"),
  },
  async ({ query, limit }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(searchTraces(readTraces(), query, limit), null, 2),
      },
    ],
  }),
);

server.tool(
  "list_recent_traces",
  "List the most recently observed traces with root operation, timestamp, service count, and completion status.",
  {
    limit: z
      .number()
      .optional()
      .default(10)
      .describe("Max traces to return (default 10)"),
  },
  async ({ limit }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(listRecentTraces(readTraces(), limit), null, 2),
      },
    ],
  }),
);

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`agentgraph MCP server error: ${err}\n`);
  process.exit(1);
});
