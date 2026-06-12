/**
 * Test B "one-line tier" entry (DESIGN §6): identical to running server.ts,
 * except tracing comes from this single import-time init() call instead of
 * the preload. Every span must carry `agentgraph.agent.id="test-agent"`.
 */
import { init } from "@agentgraph/sdk";

init({ agentId: "test-agent" });

await import("./server.ts");
