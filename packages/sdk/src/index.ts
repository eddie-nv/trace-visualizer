/**
 * @agentgraph/sdk — init(), exporter/processor wiring, and agent context API.
 *
 * Dependency direction: sdk → core (DESIGN §1).
 */

export { TRACER_NAME } from "@agentgraph/core";
export { forceFlush, init, shutdown } from "./init.js";
export type { InitOptions } from "./config.js";
export { withAgent, withConversation, type WithAgentOptions } from "./context-api.js";
// Re-exported so escape-hatch users don't need a direct OTel SDK dep for the types.
export type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
