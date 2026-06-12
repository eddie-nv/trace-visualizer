import { context, SpanKind, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { ATTR } from "./attributes.js";
import { shouldSendContent, type CoreConfig } from "./content-gating.js";
import { computeAgentFingerprint } from "./fingerprint.js";
import type { ParsedRequest, ParsedResponse, ProviderAdapter } from "./provider-types.js";
import { matchProviderAdapter } from "./providers.js";
import {
  applyUsage,
  recordSpanError,
  setJsonAttribute,
  setNumberAttribute,
  setStringAttribute,
} from "./span-attrs.js";
import { parseSseStream } from "./sse.js";
import { isFetchSpanSuppressed } from "./suppression.js";
import { TRACER_NAME } from "./tracer.js";

type Fetch = typeof globalThis.fetch;
type FetchInput = Parameters<Fetch>[0];
type FetchInit = Parameters<Fetch>[1];

/** Both matched endpoints are chat completions (DESIGN §2.1). */
const OPERATION = "chat";
const WARN_ATTRIBUTE = ATTR.WARN;
const WARN_PREFIX = "[agentgraph]";

interface HookState {
  readonly original: Fetch;
  readonly wrapper: Fetch;
}

let hookState: HookState | undefined;
let hasWarnedDisplaced = false;

/**
 * Tier-1 instrumentation (DESIGN §3): idempotently patches `globalThis.fetch`
 * to emit a GenAI span per matched provider request. Everything else passes
 * through untouched, and an instrumentation failure degrades to the original
 * call — the hook must never crash or alter the host app.
 *
 * Calling again while installed is a no-op that re-checks for displacement
 * (a user-overwritten fetch) and warns once if found.
 */
export function instrumentFetch(config?: CoreConfig): void {
  if (hookState !== undefined) {
    warnOnceIfDisplaced();
    return;
  }
  const original = globalThis.fetch;
  if (typeof original !== "function") {
    warn("globalThis.fetch is unavailable; fetch hook not installed");
    return;
  }
  const wrapper = createWrapper(original, config);
  hookState = { original, wrapper };
  globalThis.fetch = wrapper;
}

/**
 * Restores the fetch captured at instrument time. If something else replaced
 * `globalThis.fetch` after us, it is left in place — restoring would clobber
 * the replacement (and whatever the replacement wrapped).
 */
export function uninstrumentFetch(): void {
  if (hookState === undefined) {
    return;
  }
  if (globalThis.fetch === hookState.wrapper) {
    globalThis.fetch = hookState.original;
  }
  hookState = undefined;
  hasWarnedDisplaced = false;
}

function warnOnceIfDisplaced(): void {
  if (hasWarnedDisplaced || hookState === undefined || globalThis.fetch === hookState.wrapper) {
    return;
  }
  hasWarnedDisplaced = true;
  warn("globalThis.fetch was replaced after instrumentation; LLM spans may be missing");
}

function warn(message: string): void {
  // eslint-disable-next-line no-console -- the documented degrade channel (DESIGN §1, Sentry pattern)
  console.warn(`${WARN_PREFIX} ${message}`);
}

function createWrapper(original: Fetch, config: CoreConfig | undefined): Fetch {
  return function agentgraphFetch(input: FetchInput, init?: FetchInit): Promise<Response> {
    return instrumentedCall(original, config, input, init);
  };
}

interface SpanObservation {
  readonly span: Span;
  readonly adapter: ProviderAdapter;
  /** Content-gating decision captured at request time (DESIGN §4) — the
   * response is finalized in a background task where the request's context
   * is no longer active. */
  readonly sendContent: boolean;
}

async function instrumentedCall(
  original: Fetch,
  config: CoreConfig | undefined,
  input: FetchInput,
  init?: RequestInit,
): Promise<Response> {
  let observation: SpanObservation | undefined;
  try {
    observation = await beginObservation(config, input, init);
  } catch {
    observation = undefined;
  }
  if (observation === undefined) {
    return original(input, init);
  }

  let response: Response;
  try {
    response = await original(input, init);
  } catch (error) {
    recordSpanError(observation.span, error);
    observation.span.end();
    throw error;
  }

  try {
    observeResponse(observation, response);
  } catch {
    observation.span.end();
  }
  return response;
}

async function beginObservation(
  config: CoreConfig | undefined,
  input: FetchInput,
  init?: RequestInit,
): Promise<SpanObservation | undefined> {
  const url = parseRequestUrl(input);
  if (url === undefined) {
    return undefined;
  }
  const adapter = matchProviderAdapter(url, requestMethod(input, init));
  if (adapter === undefined || isFetchSpanSuppressed(context.active())) {
    return undefined;
  }

  const parsed = parseRequestBody(adapter, await readRequestBodyText(input, init));
  const sendContent = shouldSendContent(config, context.active());
  const span = startLLMSpan(adapter, parsed, sendContent);
  return { span, adapter, sendContent };
}

function parseRequestUrl(input: FetchInput): URL | undefined {
  try {
    if (typeof input === "string") {
      return new URL(input);
    }
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

function requestMethod(input: FetchInput, init?: FetchInit): string {
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  return method.toUpperCase();
}

async function readRequestBodyText(
  input: FetchInput,
  init?: RequestInit,
): Promise<string | undefined> {
  if (typeof init?.body === "string") {
    return init.body;
  }
  if (init?.body === undefined && input instanceof Request && input.body !== null) {
    if (input.bodyUsed) {
      return undefined;
    }
    return input.clone().text();
  }
  return undefined;
}

function parseRequestBody(
  adapter: ProviderAdapter,
  bodyText: string | undefined,
): ParsedRequest | undefined {
  if (bodyText === undefined) {
    return undefined;
  }
  try {
    const json: unknown = JSON.parse(bodyText);
    return typeof json === "object" && json !== null
      ? adapter.parseRequest(json as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function startLLMSpan(
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
    span.setAttribute(WARN_ATTRIBUTE, "request body not parseable");
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

function observeResponse(observation: SpanObservation, response: Response): void {
  const { span } = observation;
  if (!response.ok) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${response.status}` });
    span.end();
    return;
  }
  if (response.body === null) {
    span.end();
    return;
  }

  // clone() tees the body internally: the caller keeps the original response
  // (byte-identical, same object) while we read the clone in the background.
  let branch: Response;
  try {
    branch = response.clone();
  } catch {
    span.end();
    return;
  }
  if (isEventStream(response)) {
    void finishStreaming(observation, branch);
  } else {
    void finishJson(observation, branch);
  }
}

function isEventStream(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
}

async function finishJson(observation: SpanObservation, branch: Response): Promise<void> {
  const { span, adapter } = observation;
  try {
    const json: unknown = await branch.json();
    applyParsedResponse(observation, adapter.parseResponse(json));
  } catch {
    span.setAttribute(WARN_ATTRIBUTE, "response body not parseable");
  } finally {
    span.end();
  }
}

async function finishStreaming(observation: SpanObservation, branch: Response): Promise<void> {
  const { span, adapter } = observation;
  const accumulator = adapter.createStreamAccumulator();
  try {
    if (branch.body !== null) {
      for await (const event of parseSseStream(branch.body)) {
        try {
          accumulator.onEvent(event);
        } catch {
          // One malformed event must not abort accumulation of the rest.
        }
      }
    }
    applyParsedResponse(observation, accumulator.finish());
  } catch (error) {
    // The caller's branch of the teed body fails with the same transport
    // error; rethrowing here would only produce an unhandled rejection in a
    // background task. Record what was accumulated, then the error.
    try {
      applyParsedResponse(observation, accumulator.finish());
    } catch {
      // Partial state could not be finalized — the error below still lands.
    }
    recordSpanError(span, error);
  } finally {
    span.end();
  }
}

function applyParsedResponse(observation: SpanObservation, parsed: ParsedResponse): void {
  const { span, sendContent } = observation;
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
