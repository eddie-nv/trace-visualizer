/**
 * @agentgraph/core — LLM call patching and OTel GenAI span emission.
 *
 * Emits via whatever global `trace.getTracer(TRACER_NAME)` resolves to; knows
 * nothing about exporters or tracer providers (DESIGN §1).
 */

export const TRACER_NAME = "agentgraph";
