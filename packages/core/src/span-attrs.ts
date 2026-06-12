import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { ATTR } from "./attributes.js";
import type { Usage } from "./manual.js";

/** Shared span-attribute helpers used by every emission path (DESIGN §2). */

export function setStringAttribute(span: Span, key: string, value: string | undefined): void {
  if (typeof value === "string" && value.length > 0) {
    span.setAttribute(key, value);
  }
}

export function setNumberAttribute(span: Span, key: string, value: number | undefined): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    span.setAttribute(key, value);
  }
}

/** JSON-serializes `value`; skips silently when undefined or unserializable. */
export function setJsonAttribute(span: Span, key: string, value: unknown): void {
  if (value === undefined) {
    return;
  }
  try {
    span.setAttribute(key, JSON.stringify(value));
  } catch {
    // Circular or otherwise unserializable content — drop the attribute
    // rather than fail the emission path.
  }
}

export function applyUsage(span: Span, usage: Readonly<Usage> | undefined): void {
  if (usage === undefined) {
    return;
  }
  setNumberAttribute(span, ATTR.USAGE_INPUT_TOKENS, usage.inputTokens);
  setNumberAttribute(span, ATTR.USAGE_OUTPUT_TOKENS, usage.outputTokens);
  setNumberAttribute(span, ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS, usage.cacheCreationInputTokens);
  setNumberAttribute(span, ATTR.USAGE_CACHE_READ_INPUT_TOKENS, usage.cacheReadInputTokens);
}

export function recordSpanError(span: Span, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  span.recordException(error instanceof Error ? error : message);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/** Semconv `gen_ai.system_instructions` shape: plain strings become parts. */
export function formatSystemInstructions(system: unknown): unknown {
  return typeof system === "string" ? [{ type: "text", content: system }] : system;
}
