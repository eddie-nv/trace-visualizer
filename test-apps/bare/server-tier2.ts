/**
 * Test B tier-2 entry (M6, DESIGN §3 tier 2): tracing via
 * init({instrumentModules}) — SDK prototype patching of the already-imported
 * module, no preload, no loader hooks. The tier-1 fetch hook is ALSO active
 * (init default), so this leg is the live dedup gate (§3.4): exactly one
 * span per LLM call, and responses byte-identical to the untraced baseline.
 */
import * as AnthropicModule from "@anthropic-ai/sdk";
import { init } from "@agentgraph/sdk";

init({ agentId: "tier2-agent", instrumentModules: { anthropic: AnthropicModule } });

await import("./server.ts");
