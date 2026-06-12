/**
 * Q1 context-propagation probe (DESIGN §5 Q1): does `context.with` propagate
 * across async boundaries under this runtime (Node and, decisively, Bun)?
 *
 * Uses the real init() wiring (ALS context manager + stamping processor) with
 * an in-memory exporter, starts a span across an awaited timer inside
 * withAgent, and asserts the context-derived `agentgraph.*` stamps landed.
 * Run directly: `node|bun scripts/test-b/q1-context-probe.ts` — the Test B
 * harness spawns it under both runtimes.
 */
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { forceFlush, init, shutdown, withAgent, withConversation } from "@agentgraph/sdk";

const AGENT_ID = "ctx-probe-agent";
const CONVERSATION_ID = "ctx-probe-conversation";
const ASYNC_HOP_MS = 10;

const exporter = new InMemorySpanExporter();
init({ exporter, disableBatch: true, instrumentFetch: false });

await withAgent(AGENT_ID, async () => {
  await withConversation(CONVERSATION_ID, async () => {
    // The async hop is the point: the stamping processor must still see the
    // context keys when the span starts on the other side of the event loop.
    await new Promise((resolve) => setTimeout(resolve, ASYNC_HOP_MS));
    const span = trace.getTracer("q1-probe").startSpan("inner");
    span.end();
  });
});

await forceFlush();
const inner = exporter.getFinishedSpans().find((span) => span.name === "inner");
assert.ok(inner, "inner span was not exported");
assert.equal(inner.attributes["agentgraph.agent.id"], AGENT_ID, "agent id did not propagate");
assert.equal(
  inner.attributes["agentgraph.conversation.id"],
  CONVERSATION_ID,
  "conversation id did not propagate",
);
await shutdown();

const runtime =
  process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`;
console.log(`q1 context probe PASS (${runtime}): context.with propagates across async boundaries`);
