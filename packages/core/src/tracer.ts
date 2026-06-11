/**
 * Name passed to `trace.getTracer()` for all AgentGraph span emission.
 *
 * Core emits via whatever global tracer provider is registered; it never sets
 * one up itself (DESIGN §1).
 */
export const TRACER_NAME = "agentgraph";
