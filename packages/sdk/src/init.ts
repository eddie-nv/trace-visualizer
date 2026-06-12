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
import {
  instrumentFetch,
  manuallyInstrument,
  uninstrumentFetch,
  uninstrumentModule,
  type InstrumentedProvider,
} from "@agentgraph/core";
import { resolveConfig, type InitOptions, type ResolvedConfig } from "./config.js";
import { activateTier3 } from "./module-hooks.js";
import { StampingSpanProcessor } from "./stamping-processor.js";

type InstrumentedModuleEntry = readonly [InstrumentedProvider, unknown];

interface SdkState {
  provider: BasicTracerProvider;
  isFetchInstrumented: boolean;
  instrumentedModules: readonly InstrumentedModuleEntry[];
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
  let instrumentedModules: readonly InstrumentedModuleEntry[] = [];
  try {
    if (config.instrumentFetch) {
      instrumentFetch({
        traceContent: config.traceContent,
        ...(config.testMatchOrigins !== undefined && {
          testMatchOrigins: config.testMatchOrigins,
        }),
      });
    }
    instrumentedModules = instrumentProvidedModules(config);
    const provider = createProvider(config);
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    trace.setGlobalTracerProvider(provider);
    if (config.instrumentSdks) {
      // Tier 3 (DESIGN §3): after provider registration so hooked modules
      // emit through it. activateTier3 never throws; both failure modes —
      // loader hook unavailable (ESM-only loss) and instrumentation enabling
      // failed (all of tier 3 lost) — degrade to tier 1 with their own
      // distinct warnings, because the preload path must never crash a host.
      activateTier3({ traceContent: config.traceContent });
    }
    state = { provider, isFetchInstrumented: config.instrumentFetch, instrumentedModules };
  } catch (error) {
    // don't leave hooks installed with no state to uninstall them from
    if (config.instrumentFetch) {
      uninstrumentFetch();
    }
    uninstrumentProvidedModules(instrumentedModules);
    throw error;
  }
}

/** Tier-2 activation (DESIGN §3 tier 2): patch each provided SDK module.
 * `manuallyInstrument` degrades to a warn on bad shapes, so every entry is
 * recorded for symmetric un-instrumentation at shutdown. */
function instrumentProvidedModules(config: ResolvedConfig): readonly InstrumentedModuleEntry[] {
  const modules = config.instrumentModules;
  if (modules === undefined) {
    return [];
  }
  const providers: readonly InstrumentedProvider[] = ["anthropic", "openai"];
  return providers
    .filter((provider) => modules[provider] !== undefined)
    .map((provider) => {
      const module = modules[provider];
      manuallyInstrument(provider, module, { traceContent: config.traceContent });
      return [provider, module] as const;
    });
}

function uninstrumentProvidedModules(entries: readonly InstrumentedModuleEntry[]): void {
  for (const [provider, module] of entries) {
    uninstrumentModule(provider, module);
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
  uninstrumentProvidedModules(active.instrumentedModules);
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
