import { createContextKey, type Context } from "@opentelemetry/api";

/**
 * Context key checked by the fetch hook before creating a span (DESIGN §3.4).
 * Tier-2 SDK wrappers run their bodies under a context with this key set to
 * `true`, so a wrapped call that internally uses fetch yields exactly one
 * span. Same mechanism as OpenLLMetry's `suppressTracing` context usage.
 */
export const SUPPRESS_FETCH_SPAN_KEY = createContextKey("agentgraph.suppress_fetch_span");

/** True when the given context requests fetch-span suppression. */
export function isFetchSpanSuppressed(ctx: Context): boolean {
  return ctx.getValue(SUPPRESS_FETCH_SPAN_KEY) === true;
}
