/**
 * Shared LLM span lifecycle (DESIGN §2): request-side span creation and
 * response-side attribute application. Used by both the tier-1 fetch hook
 * and the tier-2 SDK instrumentations so the emitted schema cannot drift
 * between tiers.
 */
import { SpanKind, trace, type Span } from "@opentelemetry/api";
import { ATTR } from "./attributes.js";
import { computeAgentFingerprint } from "./fingerprint.js";
import type { ParsedRequest, ParsedResponse, ProviderAdapter } from "./provider-types.js";
import {
  applyUsage,
  setJsonAttribute,
  setNumberAttribute,
  setStringAttribute,
} from "./span-attrs.js";
import { TRACER_NAME } from "./tracer.js";

/** Both matched endpoints are chat completions (DESIGN §2.1). */
export const OPERATION = "chat";

/** Start a `chat {model}` CLIENT span from the parsed request (DESIGN §2.1). */
export function startLLMSpan(
  adapter: ProviderAdapter,
  parsed: ParsedRequest | undefined,
  sendContent: boolean,
): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(
    parsed?.model === undefined ? OPERATION : `${OPERATION} ${parsed.model}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR.PROVIDER_NAME]: adapter.providerName,
        [ATTR.OPERATION_NAME]: OPERATION,
      },
    },
  );
  if (parsed === undefined) {
    span.setAttribute(ATTR.WARN, "request body not parseable");
    return span;
  }
  setStringAttribute(span, ATTR.REQUEST_MODEL, parsed.model);
  setNumberAttribute(span, ATTR.REQUEST_MAX_TOKENS, parsed.maxTokens);
  setNumberAttribute(span, ATTR.REQUEST_TEMPERATURE, parsed.temperature);
  setNumberAttribute(span, ATTR.REQUEST_TOP_P, parsed.topP);
  setNumberAttribute(span, ATTR.REQUEST_TOP_K, parsed.topK);
  setNumberAttribute(span, ATTR.REQUEST_FREQUENCY_PENALTY, parsed.frequencyPenalty);
  setNumberAttribute(span, ATTR.REQUEST_PRESENCE_PENALTY, parsed.presencePenalty);
  applyFingerprint(span, adapter.providerName, parsed);
  if (sendContent) {
    setJsonAttribute(span, ATTR.INPUT_MESSAGES, parsed.messages);
    setJsonAttribute(span, ATTR.SYSTEM_INSTRUCTIONS, parsed.systemInstructions);
    setJsonAttribute(span, ATTR.TOOL_DEFINITIONS, parsed.toolDefinitions);
  }
  return span;
}

function applyFingerprint(span: Span, provider: string, parsed: ParsedRequest): void {
  if (parsed.model === undefined) {
    return;
  }
  try {
    const input = {
      provider,
      model: parsed.model,
      ...(parsed.toolNames === undefined ? {} : { toolNames: parsed.toolNames }),
      ...(parsed.systemPromptText === undefined ? {} : { systemPrompt: parsed.systemPromptText }),
    };
    span.setAttribute(ATTR.AGENT_FINGERPRINT, computeAgentFingerprint(input));
  } catch {
    // Fingerprint is best-effort metadata (DESIGN Q4) — never fail the span.
  }
}

/** Apply response-side attributes; the content gate decision was captured at
 * request time (DESIGN §4) because responses finalize outside that context. */
export function applyParsedResponse(
  span: Span,
  sendContent: boolean,
  parsed: ParsedResponse,
): void {
  setStringAttribute(span, ATTR.RESPONSE_ID, parsed.id);
  setStringAttribute(span, ATTR.RESPONSE_MODEL, parsed.model);
  if (parsed.finishReasons !== undefined && parsed.finishReasons.length > 0) {
    span.setAttribute(ATTR.RESPONSE_FINISH_REASONS, [...parsed.finishReasons]);
  }
  applyUsage(span, parsed.usage);
  if (sendContent) {
    setJsonAttribute(span, ATTR.OUTPUT_MESSAGES, parsed.outputMessages);
  }
}
