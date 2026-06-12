import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { instrumentFetch, uninstrumentFetch } from "@agentgraph/core";
import { resolveConfig, type InitOptions, type ResolvedConfig } from "./config.js";
import { StampingSpanProcessor } from "./stamping-processor.js";

interface SdkState {
  provider: BasicTracerProvider;
  isFetchInstrumented: boolean;
}

let state: SdkState | undefined;

/**
 * Initialize AgentGraph tracing (DESIGN §1). Ordering, copied from
 * traceloop's `startTracing()`:
 *
 * 1. env defaulting (`resolveConfig` — fails fast on bad endpoint, before
 *    any hook is installed)
 * 2. hook install — tier-1 fetch hook unless `instrumentFetch: false`
 * 3. exporter — `options.exporter` ?? OTLP/HTTP protobuf at
 *    `${endpoint}/v1/traces`
 * 4. span processor — Simple/Batch per `disableBatch`, wrapped with the
 *    `onStart` stamping processor; `options.processor` appended additively
 * 5. resource + `BasicTracerProvider` + ALS context manager registration
 *
 * Calling `init()` again before `shutdown()` warns and is a no-op.
 */
export function init(options?: InitOptions): void {
  if (state !== undefined) {
    console.warn("agentgraph: init() called more than once; ignoring this call");
    return;
  }
  const config = resolveConfig(options);
  if (config.instrumentFetch) {
    instrumentFetch({ traceContent: config.traceContent });
  }
  try {
    const provider = createProvider(config);
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    state = { provider, isFetchInstrumented: config.instrumentFetch };
  } catch (error) {
    // don't leave the fetch hook installed with no state to uninstall it from
    if (config.instrumentFetch) {
      uninstrumentFetch();
    }
    throw error;
  }
}

/** Flush all pending spans. Warns and resolves when called before `init()`. */
export function forceFlush(): Promise<void> {
  if (state === undefined) {
    console.warn("agentgraph: forceFlush() called before init(); nothing to flush");
    return Promise.resolve();
  }
  return state.provider.forceFlush();
}

/**
 * Flush and tear down: uninstall the fetch hook, shut the provider down, and
 * unregister the globals so `init()` may run again. Warns and resolves when
 * called before `init()`.
 */
export async function shutdown(): Promise<void> {
  if (state === undefined) {
    console.warn("agentgraph: shutdown() called before init(); nothing to shut down");
    return;
  }
  const active = state;
  state = undefined;
  if (active.isFetchInstrumented) {
    uninstrumentFetch();
  }
  try {
    await active.provider.shutdown();
  } finally {
    trace.disable();
    context.disable(); // also disables the registered ALS context manager
  }
}

function createProvider(config: ResolvedConfig): BasicTracerProvider {
  const exporter =
    config.exporter ??
    new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
      headers: config.headers,
    });
  const inner: SpanProcessor = config.disableBatch
    ? new SimpleSpanProcessor(exporter)
    : new BatchSpanProcessor(exporter);
  const stamping = new StampingSpanProcessor(inner, { agentId: config.agentId });
  const spanProcessors = config.processor === undefined ? [stamping] : [stamping, config.processor];
  return new BasicTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": config.serviceName }),
    ),
    spanProcessors,
  });
}
