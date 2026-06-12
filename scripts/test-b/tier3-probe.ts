/**
 * Tier-3 E2E probe (M6, DESIGN §3 tier 3): with `AGENTGRAPH_INSTRUMENT_SDKS=true`
 * and the tier-1 fetch hook DISABLED, a real `@anthropic-ai/sdk` imported
 * *after* init() must still produce a span — proving the import-in-the-middle
 * loader hook intercepted the module and the prototype patch + suppression
 * pipeline ran. Node-only (`module.register`); the harness spawns it.
 *
 * Run: AGENTGRAPH_INSTRUMENT_SDKS=true node scripts/test-b/tier3-probe.ts
 */
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { forceFlush, init, shutdown } from "@agentgraph/sdk";
import { startMockAnthropic } from "./mock-anthropic.ts";

assert.equal(
  process.env["AGENTGRAPH_INSTRUMENT_SDKS"],
  "true",
  "probe requires AGENTGRAPH_INSTRUMENT_SDKS=true in the environment",
);

const PROBE_MODEL = "claude-tier3-probe";

const exporter = new InMemorySpanExporter();
const mock = await startMockAnthropic();

// Tier 1 off: any span MUST have come from the tier-3 module interception.
init({ exporter, disableBatch: true, instrumentFetch: false });

// Import AFTER init so the registered loader hook sees the module load.
const { default: Anthropic } = await import("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: "probe-key", baseURL: mock.origin });

const message = await client.messages.create({
  model: PROBE_MODEL,
  max_tokens: 64,
  messages: [{ role: "user", content: "tier-3 probe" }],
});

await forceFlush();
const spans = exporter.getFinishedSpans();
assert.equal(message.id, "msg_mock_json_001", "mock response did not round-trip");
assert.equal(
  spans.length,
  1,
  `expected exactly 1 tier-3 span, got ${spans.length} (${spans.map((span) => span.name).join(", ")})`,
);
assert.equal(spans[0]!.name, `chat ${PROBE_MODEL}`, "span name");
assert.equal(spans[0]!.attributes["gen_ai.provider.name"], "anthropic", "provider attr");
assert.equal(spans[0]!.attributes["gen_ai.usage.output_tokens"], 42, "usage attr");

await shutdown();
await mock.close();
console.log(
  `tier-3 probe PASS (node ${process.version}): loader hook intercepted @anthropic-ai/sdk and emitted 1 span`,
);
