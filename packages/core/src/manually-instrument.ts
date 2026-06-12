/**
 * Tier-2 SDK prototype patching (DESIGN §3 tier 2) — the loader-hook-free
 * escape hatch (OpenLLMetry's `manuallyInstrument` pattern). Wraps the chat
 * `create` method of a directly-provided SDK module. The wrapper:
 *
 * - emits the same span schema as the fetch tier via `span-lifecycle.ts`,
 *   so the two tiers cannot drift;
 * - runs the original under `SUPPRESS_FETCH_SPAN_KEY` so with both tiers
 *   active exactly ONE span is emitted per LLM call (§3.4);
 * - taps the returned promise/stream WITHOUT replacing it — the caller keeps
 *   the SDK's own `APIPromise`/`Stream` object (its iterator is wrapped in
 *   place), preserving the F6 behavior-identity guarantee;
 * - never crashes the host: every instrumentation failure degrades to the
 *   plain original call with at most a single console.warn.
 */
import { context, type Span } from "@opentelemetry/api";
import { ATTR } from "./attributes.js";
import { shouldSendContent, type CoreConfig } from "./content-gating.js";
import { anthropicAdapter } from "./provider-anthropic.js";
import { openaiAdapter } from "./provider-openai.js";
import { isRecord, type ParsedEventAccumulator, type ProviderAdapter } from "./provider-types.js";
import { recordSpanError } from "./span-attrs.js";
import { applyParsedResponse, startLLMSpan } from "./span-lifecycle.js";
import { SUPPRESS_FETCH_SPAN_KEY } from "./suppression.js";

export type InstrumentedProvider = "anthropic" | "openai";

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
type Indexable = Record<PropertyKey, unknown>;

/** The wrapper carries its original here — the idempotency and unwrap handle. */
const ORIGINAL_KEY = Symbol.for("agentgraph.original-create");

const WARN_PREFIX = "[agentgraph]";
let warnedKeys = new Set<string>();

/**
 * Patch the provider SDK's chat `create` prototype method on a module object
 * the caller already imported (works without loader hooks, including under
 * bundlers and Bun). Idempotent; unexpected module shapes warn once and
 * leave the module untouched.
 */
export function manuallyInstrument(
  provider: InstrumentedProvider,
  module: unknown,
  config?: CoreConfig,
): void {
  try {
    const holder = resolveCreateHolder(provider, module);
    if (holder === undefined) {
      warnOnce(
        `shape:${provider}`,
        `could not instrument the ${provider} SDK — unexpected module shape; tier-2 spans are disabled for it`,
      );
      return;
    }
    const original = holder["create"] as AnyFn;
    if ((original as unknown as Indexable)[ORIGINAL_KEY] !== undefined) {
      return; // already wrapped — keep exactly one layer
    }
    const adapter = provider === "anthropic" ? anthropicAdapter : openaiAdapter;
    const wrapped = createWrappedCreate(original, adapter, config);
    (wrapped as unknown as Indexable)[ORIGINAL_KEY] = original;
    holder["create"] = wrapped;
  } catch (error) {
    warnOnce(
      `patch:${provider}`,
      `failed to instrument the ${provider} SDK (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Restore the original `create` if (and only if) our wrapper is in place. */
export function uninstrumentModule(provider: InstrumentedProvider, module: unknown): void {
  try {
    const holder = resolveCreateHolder(provider, module);
    const original = (holder?.["create"] as Indexable | undefined)?.[ORIGINAL_KEY];
    if (holder !== undefined && typeof original === "function") {
      holder["create"] = original;
    }
  } catch {
    // Unwrapping a module we never touched (or a hostile shape) is a no-op.
  }
}

/** Reset warn-once state (test hook, mirrors uninstrumentFetch's reset). */
export function resetManualInstrumentationWarnings(): void {
  warnedKeys = new Set();
}

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) {
    return;
  }
  warnedKeys.add(key);
  console.warn(`${WARN_PREFIX} ${message}`);
}

/**
 * Find the object holding `create` for the provider:
 * anthropic → `(module.Anthropic ?? module.default ?? module).Messages.prototype`
 * openai → `(module.OpenAI ?? module.default ?? module).Chat.Completions.prototype`
 */
function resolveCreateHolder(
  provider: InstrumentedProvider,
  module: unknown,
): Indexable | undefined {
  const moduleRecord = asIndexable(module);
  if (moduleRecord === undefined) {
    return undefined;
  }
  const rootName = provider === "anthropic" ? "Anthropic" : "OpenAI";
  const root =
    asIndexable(moduleRecord[rootName]) ?? asIndexable(moduleRecord["default"]) ?? moduleRecord;
  const resource =
    provider === "anthropic"
      ? asIndexable(root["Messages"])
      : asIndexable(asIndexable(root["Chat"])?.["Completions"]);
  const prototype = asIndexable(resource?.["prototype"]);
  return prototype !== undefined && typeof prototype["create"] === "function"
    ? prototype
    : undefined;
}

/** Classes are functions — `isRecord` alone would reject them. */
function asIndexable(value: unknown): Indexable | undefined {
  if (typeof value === "function" || (typeof value === "object" && value !== null)) {
    return value as Indexable;
  }
  return undefined;
}

interface SpanObservation {
  readonly span: Span;
  readonly sendContent: boolean;
}

function createWrappedCreate(
  original: AnyFn,
  adapter: ProviderAdapter,
  config: CoreConfig | undefined,
): AnyFn {
  return function agentgraphCreate(this: unknown, ...args: unknown[]): unknown {
    let observation: SpanObservation | undefined;
    try {
      const params = isRecord(args[0]) ? args[0] : undefined;
      const sendContent = shouldSendContent(config, context.active());
      const span = startLLMSpan(
        adapter,
        params === undefined ? undefined : adapter.parseRequest(params),
        sendContent,
      );
      observation = { span, sendContent };
    } catch {
      warnOnce(
        "span-setup",
        "failed to start an LLM span; instrumented SDK calls are not being traced",
      );
      observation = undefined;
    }
    if (observation === undefined) {
      return original.apply(this, args);
    }

    // §3.4 dedup: everything the SDK does inside — including its internal
    // globalThis.fetch — runs with fetch-tier span creation suppressed. The
    // ALS context manager carries the key through the SDK's async chain.
    const suppressed = context.active().setValue(SUPPRESS_FETCH_SPAN_KEY, true);
    let result: unknown;
    try {
      result = context.with(suppressed, () => original.apply(this, args));
    } catch (error) {
      recordSpanError(observation.span, error);
      observation.span.end();
      throw error;
    }
    observeResult(result, observation, adapter);
    return result;
  };
}

function observeResult(
  result: unknown,
  observation: SpanObservation,
  adapter: ProviderAdapter,
): void {
  const { span } = observation;
  if (!isThenable(result)) {
    span.setAttribute(ATTR.WARN, "SDK call returned a non-promise; response not captured");
    span.end();
    return;
  }
  // Tap, never replace: the caller keeps the SDK's own APIPromise. Our
  // then-callback is registered first, so a streaming result has its
  // iterator wrapped before the caller's continuation can start consuming.
  const tapped = result.then(
    (value: unknown) => {
      observeResolvedValue(value, observation, adapter);
    },
    (error: unknown) => {
      recordSpanError(span, error);
      span.end();
    },
  );
  // Our derived promise must never surface as an unhandled rejection.
  if (isThenable(tapped)) {
    void tapped.then(undefined, () => {});
  }
}

function observeResolvedValue(
  value: unknown,
  observation: SpanObservation,
  adapter: ProviderAdapter,
): void {
  const { span, sendContent } = observation;
  try {
    if (isAsyncIterable(value)) {
      wrapStreamInstance(value, observation, adapter);
      return; // the span ends when the stream finishes (or is abandoned early)
    }
    applyParsedResponse(span, sendContent, adapter.parseResponse(value));
    span.end();
  } catch {
    span.setAttribute(ATTR.WARN, "response observation failed");
    span.end();
  }
}

/**
 * Wrap the stream's `[Symbol.asyncIterator]` in place: the caller keeps the
 * SDK's Stream object (`.tee()`, `.controller`, … untouched); iteration
 * yields the SDK's own event objects unchanged while feeding the provider
 * accumulator (`onParsedEvent`).
 */
function wrapStreamInstance(
  stream: AsyncIterable<unknown>,
  observation: SpanObservation,
  adapter: ProviderAdapter,
): void {
  const target = stream as AsyncIterable<unknown> & Indexable;
  const originalFactory = (target[Symbol.asyncIterator] as () => AsyncIterator<unknown>).bind(
    stream,
  );
  const accumulator = adapter.createStreamAccumulator();
  target[Symbol.asyncIterator] = (): AsyncIterator<unknown> =>
    instrumentedIteration(originalFactory(), accumulator, observation);
}

async function* instrumentedIteration(
  inner: AsyncIterator<unknown>,
  accumulator: ParsedEventAccumulator,
  observation: SpanObservation,
): AsyncGenerator<unknown, void, undefined> {
  const { span, sendContent } = observation;
  let eventFailures = 0;
  let sawEnd = false;
  let applied = false;

  const applyAccumulated = (): void => {
    if (applied) {
      return;
    }
    applied = true;
    try {
      applyParsedResponse(span, sendContent, accumulator.finish());
    } catch {
      span.setAttribute(ATTR.WARN, "stream accumulator failed");
    }
  };

  try {
    while (true) {
      const next = await inner.next();
      if (next.done === true) {
        sawEnd = true;
        break;
      }
      try {
        accumulator.onParsedEvent(next.value);
      } catch {
        eventFailures += 1;
      }
      yield next.value;
    }
    applyAccumulated();
  } catch (error) {
    applyAccumulated(); // record what was accumulated before the failure
    recordSpanError(span, error);
    throw error;
  } finally {
    if (!sawEnd) {
      // Early consumer exit: release the SDK's stream, then record partials.
      try {
        await inner.return?.();
      } catch {
        // The upstream is being abandoned; its teardown errors are not ours.
      }
      applyAccumulated();
    }
    if (eventFailures > 0) {
      span.setAttribute(ATTR.WARN, `${eventFailures} stream event(s) could not be processed`);
    }
    span.end();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Indexable)[Symbol.asyncIterator] === "function"
  );
}
