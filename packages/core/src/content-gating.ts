import { context, createContextKey, type Context } from "@opentelemetry/api";

/** Configuration shared by every core emission path. */
export interface CoreConfig {
  /** Capture message content on spans. Default true (DESIGN §4). */
  traceContent?: boolean;
}

/**
 * Per-call content-capture override. Set a boolean on the active context to
 * force content on/off for everything emitted inside it; the SDK's `init()`
 * also uses this key to apply a process-wide `traceContent` setting.
 */
export const ALLOW_TRACE_CONTENT_KEY = createContextKey("agentgraph.allow_trace_content");

const TRACE_CONTENT_ENV = "AGENTGRAPH_TRACE_CONTENT";

/**
 * The single content gate (DESIGN §4) — consulted by every emission path so
 * the OpenLLMetry propagate-the-toggle bugs cannot recur.
 *
 * Resolution order: context-key override → off iff `config.traceContent ===
 * false` or `AGENTGRAPH_TRACE_CONTENT === "false"` → default true.
 *
 * The `config` parameter is threaded by instrumentation entry points that
 * accept a `CoreConfig`; direct callers (e.g. the manual API) pass nothing.
 */
export function shouldSendContent(config?: CoreConfig, ctx: Context = context.active()): boolean {
  const override = ctx.getValue(ALLOW_TRACE_CONTENT_KEY);
  if (typeof override === "boolean") {
    return override;
  }
  if (config?.traceContent === false) {
    return false;
  }
  return readEnv(TRACE_CONTENT_ENV) !== "false";
}

function readEnv(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name];
}
