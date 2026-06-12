/**
 * Source-agnostic LLM query contract (DESIGN §2.3, Test C) — THE ingestion
 * predicate for the future graph layer. One code path must select and read
 * LLM-call spans from our shim, OpenLLMetry, and AI SDK v6/v7 native
 * telemetry. The ONLY source-specific accommodation permitted is the
 * documented `gen_ai.provider.name ?? gen_ai.system` coalesce (AI SDK v6
 * emits the legacy `gen_ai.system` key).
 *
 * Consumers must NOT depend on anything outside this contract — span names,
 * content attributes, and tool-call representation all differ per source
 * (FINDINGS §1.4).
 */
import { ATTR } from "./attributes.js";

/** Storage-agnostic span attribute view (OTel SDK, Jaeger tags, OTLP JSON…). */
export type SpanAttributes = Readonly<Record<string, unknown>>;

/** AI SDK v6 emits the pre-1.40 provider key; v7 and OpenLLMetry use ATTR.PROVIDER_NAME. */
const LEGACY_PROVIDER_ATTR = "gen_ai.system";

export interface LLMUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/**
 * An LLM call is a span carrying a request model AND at least one usage
 * token count — true for our `chat {model}` spans, AI SDK v6/v7
 * doStream/doGenerate spans, and OpenLLMetry spans; false for AI SDK root
 * spans (`ai.*` namespace only) and tool spans.
 */
export function isLLMCall(attributes: SpanAttributes): boolean {
  return (
    attributes[ATTR.REQUEST_MODEL] !== undefined &&
    (attributes[ATTR.USAGE_INPUT_TOKENS] !== undefined ||
      attributes[ATTR.USAGE_OUTPUT_TOKENS] !== undefined)
  );
}

/** The provider behind the call, via the single documented coalesce. */
export function provider(attributes: SpanAttributes): string | undefined {
  return (
    asNonEmptyString(attributes[ATTR.PROVIDER_NAME]) ??
    asNonEmptyString(attributes[LEGACY_PROVIDER_ATTR])
  );
}

/** Token usage; numeric strings are accepted because Jaeger stringifies
 * int64 tag values outside the JS safe-integer range. */
export function usage(attributes: SpanAttributes): LLMUsage {
  const inputTokens = asTokenCount(attributes[ATTR.USAGE_INPUT_TOKENS]);
  const outputTokens = asTokenCount(attributes[ATTR.USAGE_OUTPUT_TOKENS]);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTokenCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
