/**
 * @agentgraph/core — LLM call patching and OTel GenAI span emission.
 *
 * Emits via whatever global `trace.getTracer(TRACER_NAME)` resolves to; knows
 * nothing about exporters or tracer providers (DESIGN §1).
 */

export { TRACER_NAME } from "./tracer.js";
export { ATTR, CONTENT_ATTRIBUTES, type ContentAttributeKey } from "./attributes.js";
export { ALLOW_TRACE_CONTENT_KEY, shouldSendContent, type CoreConfig } from "./content-gating.js";
export { computeAgentFingerprint, type FingerprintInput } from "./fingerprint.js";
export { instrumentFetch, uninstrumentFetch, type FetchHookConfig } from "./fetch-hook.js";
export type { MatchOriginOverrides } from "./providers.js";
export {
  manuallyInstrument,
  uninstrumentModule,
  type InstrumentedProvider,
} from "./manually-instrument.js";
export {
  AnthropicInstrumentation,
  OpenAIInstrumentation,
  type SdkInstrumentationConfig,
} from "./instrumentations.js";
export {
  isLLMCall,
  provider,
  usage,
  type LLMUsage,
  type SpanAttributes,
} from "./query-contract.js";
export { SUPPRESS_FETCH_SPAN_KEY } from "./suppression.js";
export {
  withLLMCall,
  type LLMCallAttributes,
  type LLMOperation,
  type LLMSpan,
  type LLMSpanAfterRequest,
  type LLMSpanRequest,
  type LLMSpanResponse,
  type Usage,
} from "./manual.js";
