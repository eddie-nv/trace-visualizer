# AgentGraph Instrumentation — Design

Derived from `research/FINDINGS.md` (Phase 1). Every pattern below cites its source there or in `research/raw/*`. Anything not traceable to the findings is marked **⚠️ INVENTION** and listed in the Open Questions section.

## 0. Goals and non-goals

**Goal:** zero-code (preload) or one-line (`init()`) capture of LLM calls as OTel GenAI spans, exported over OTLP/HTTP, source-agnostic with AI SDK native telemetry (Test C), Node and Bun.

**Non-goals (v0):** metrics/logs signals, OpenAI Responses API streaming (not even OpenLLMetry instruments it — FINDINGS §7 F7), browser runtimes, gRPC OTLP (vercel/otel doesn't support it either — FINDINGS §8/Test A facts).

---

## 1. Package layout

Three packages, dependency direction `register → sdk → core`. Mirrors the split the references converged on: OpenLLMetry's per-concern packages (`instrumentation-*` vs `traceloop-sdk`, raw/1A §1A.1/§1A.5) and Sentry's `init`/`preload` entries as thin side-effect modules over the SDK (FINDINGS §5).

### `@agentgraph/core` — patching + span emission (no provider setup)

Knows nothing about exporters or tracer providers; emits via whatever global `trace.getTracer("agentgraph")` resolves to, exactly like AI SDK's `getTracer` pattern (FINDINGS §1.3).

Public API:

```ts
// Tier 1 — fetch hook (primary)
export function instrumentFetch(config?: CoreConfig): void;     // idempotent, patches globalThis.fetch
export function uninstrumentFetch(): void;

// Tier 2 — SDK prototype patching, OpenLLMetry-style classes (FINDINGS §2)
export class AnthropicInstrumentation extends InstrumentationBase {
  init(): InstrumentationNodeModuleDefinition;                  // "@anthropic-ai/sdk", [">=0.9.1"]
  manuallyInstrument(module: typeof import("@anthropic-ai/sdk")): void;  // escape hatch, raw/1A §1A.8
}
export class OpenAIInstrumentation extends InstrumentationBase { /* "openai", [">=4 <7"] */ }

// Manual escape hatch (FINDINGS §3, modeled on withLLMCall/LLMSpan, manual.ts:73-201)
export function withLLMCall<T>(
  attrs: { provider: string; operation: "chat" | "text_completion" },
  fn: (span: LLMSpan) => T | Promise<T>,
): Promise<T>;
export interface LLMSpan {
  // M1 refinement (type-design-analyzer): staged interface — reportRequest returns the
  // handle carrying reportResponse, making response-before-request unrepresentable.
  reportRequest(req: { model: string; messages: unknown[]; system?: unknown }): LLMSpanAfterRequest;
}
export interface LLMSpanAfterRequest {
  reportResponse(res: { model?: string; usage?: Usage; messages?: unknown[]; finishReasons?: string[] }): void;
}

// Shared
export interface CoreConfig { traceContent?: boolean; }
export const ATTR: { /* attribute-name constants, §2 below */ };
export const SUPPRESS_FETCH_SPAN_KEY: symbol;                   // context key, §3.4
```

Differences from OpenLLMetry's manual API, both deliberate (their bugs, raw/1A §1A.7): our `LLMSpan` emits semconv-1.40 JSON message attributes (not flattened `gen_ai.prompt.<i>.*`), and it **respects content gating** (theirs doesn't).

### `@agentgraph/register` — preload entry

Side-effect-only modules, modeled on `@sentry/node/init` + `@sentry/node/preload` (FINDINGS §5):

- `@agentgraph/register` — ESM entry for `node --import @agentgraph/register` / `NODE_OPTIONS="--import @agentgraph/register"` / `bun --preload @agentgraph/register`. Top-level side effect: call `sdk.init()` configured **purely from env vars** (like `@sentry/node/init`, `packages/node/src/init.ts:1-9`).
- `@agentgraph/register/cjs` — CJS twin for `--require` (Sentry exposes both, FINDINGS §5).

Behavioral rules copied from Sentry's preload (FINDINGS §5, §7):
- Idempotency via a global flag (`globalThis.__AGENTGRAPH__.registered`), per `GLOBAL_OBJ._sentryEsmLoaderHookRegistered` (`esmLoader.ts:12-31`).
- All failures are caught and downgraded to a single `console.warn` — never crash the host app (`esmLoader.ts:27-29`).
- Default behavior installs **tier 1 only** (fetch hook). It does NOT register module-load hooks; that keeps the preload Bun-safe and bundler-safe (§3). Setting `AGENTGRAPH_INSTRUMENT_SDKS=true` opts into tier 3 (module hooks activating the tier-2 classes).

### `@agentgraph/sdk` — init + context API

Public API (options modeled on `InitializeOptions`, raw/1A §1A.5, pruned):

```ts
export function init(options?: {
  agentId?: string;                  // → agentgraph.agent.id on all spans
  serviceName?: string;              // resource service.name; default npm_package_name (traceloop configuration/index.ts:39-41)
  endpoint?: string;                 // OTLP HTTP base; exporter posts to `${endpoint}/v1/traces` (traceloop tracing/index.ts:319-326)
  headers?: Record<string, string>;
  exporter?: SpanExporter;           // override escape hatch
  processor?: SpanProcessor;         // additive, appended (traceloop tracing/index.ts:337-340)
  disableBatch?: boolean;            // Simple vs Batch processor (span-processor.ts:113-115)
  traceContent?: boolean;            // §4
  instrumentModules?: {              // tier-2 manual activation (raw/1A §1A.8)
    anthropic?: typeof import("@anthropic-ai/sdk");
    openai?: typeof import("openai");
  };
  instrumentFetch?: boolean;         // default true
}): void;

export function withAgent<T>(
  opts: string | { agentId: string; conversationId?: string; channelType?: string },
  fn: () => T,
): T;                                // §3.5 — context keys + processor stamping
export function withConversation<T>(conversationId: string, fn: () => T): T;
export function forceFlush(): Promise<void>;
export function shutdown(): Promise<void>;
```

`init()` ordering, copied from `startTracing()` (FINDINGS §5): (1) env defaulting; (2) hook installation — `instrumentFetch()` always (unless disabled), `manuallyInstrument(...)` per provided `instrumentModules` entry; (3) exporter = `options.exporter ?? OTLPTraceExporter` (**OTLP/HTTP protobuf**, same as traceloop, `tracing/index.ts:4,319-326`) at `${endpoint}/v1/traces`; (4) span processor = `disableBatch ? Simple : Batch`, wrapped with our `onStart` stamping processor (§3.5); (5) resource + provider registration. We use `BasicTracerProvider` + an `AsyncLocalStorage` context manager rather than full `NodeSDK` — `NodeSDK` drags in the module-hook machinery we're explicitly not depending on by default. **⚠️ INVENTION** (deviation): the references both use NodeSDK/BasicTracerProvider on Node only; running this provider setup under Bun is unverified → Open Question Q1.

Env vars (read in `init()`, same precedence style as traceloop `configuration/index.ts:32-44`):

| Env | Maps to | Mirrors |
|---|---|---|
| `AGENTGRAPH_ENDPOINT` | `endpoint` (default `http://localhost:4318`) | `TRACELOOP_BASE_URL` |
| `AGENTGRAPH_HEADERS` | `headers` (`k=v,k2=v2`) | `TRACELOOP_HEADERS` / OTLP convention |
| `AGENTGRAPH_TRACE_CONTENT` | `traceContent` | `TRACELOOP_TRACE_CONTENT` (§4) |
| `AGENTGRAPH_DISABLE_BATCH` | `disableBatch` | `disableBatch` option |
| `AGENTGRAPH_AGENT_ID` | `agentId` | (ours) |
| `AGENTGRAPH_INSTRUMENT_SDKS` | enable tier 3 from preload | `SENTRY_PRELOAD_INTEGRATIONS` precedent |

---

## 2. Span schema

### 2.1 LLM spans

Name `` `${operation} ${model}` `` (e.g. `chat claude-sonnet-4-6`), `SpanKind.CLIENT` — verbatim OpenLLMetry (raw/1A §1A.3, anthropic L305-308).

Adopt OTel GenAI semconv ≥1.40 **verbatim, OpenLLMetry's current set** (FINDINGS §1.1):

- Always: `gen_ai.provider.name`, `gen_ai.operation.name`, `gen_ai.request.model`, `gen_ai.request.{max_tokens,temperature,top_p,top_k,frequency_penalty,presence_penalty}` (when present), `gen_ai.response.model`, `gen_ai.response.id`, `gen_ai.response.finish_reasons`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `gen_ai.usage.cache_read.input_tokens`.
- Content-gated (§4): `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.output.messages` — JSON shapes per the OpenLLMetry format contract (`packages/instrumentation-utils/src/message-formatters.ts:44-142`).
- We do **not** emit Traceloop's `gen_ai.usage.total_tokens` (non-standard, FINDINGS §1.1) — consumers sum input+output.

### 2.2 AgentGraph namespace

Stamped on **every** span via the `onStart` processor (mechanism §3.5):

| Attribute | Source | Notes |
|---|---|---|
| `agentgraph.agent.id` | `init({agentId})` / `withAgent()` / `AGENTGRAPH_AGENT_ID` | analog of `traceloop.workflow.name` stamping (span-processor.ts:157-163) |
| `agentgraph.conversation.id` | `withAgent()`/`withConversation()` | analog of `gen_ai.conversation.id` stamping (span-processor.ts:203-206); we additionally emit standard `gen_ai.conversation.id` with the same value |
| `agentgraph.channel.type` | `withAgent({channelType})` | **⚠️ INVENTION** — required by product spec, no reference analog; free-form string (`"slack"`, `"http"`, `"cron"`) |
| `agentgraph.agent.fingerprint` | computed | **⚠️ INVENTION** — see Q6. Proposed: stable hash of (provider, model, sorted tool names, first 256 chars of system prompt), computed per LLM call, to cluster unconfigured agents. Cheap to compute at both tiers since all inputs are request-visible. |

### 2.3 Source-agnostic query contract (drives Test C)

From FINDINGS §1.4 — a consumer finds LLM calls across our shim, OpenLLMetry, and AI SDK v6/v7 native telemetry with:

```
isLLMCall(span)  := span.attributes["gen_ai.request.model"] exists
                    AND (gen_ai.usage.input_tokens OR gen_ai.usage.output_tokens) exists
provider(span)   := gen_ai.provider.name ?? gen_ai.system          // v6 emits gen_ai.system
usage(span)      := gen_ai.usage.input_tokens / gen_ai.usage.output_tokens   // identical in all three
```

Known non-equivalences the consumer must NOT depend on (and Test C must assert only on the contract above): content attributes (`gen_ai.input.messages` vs AI SDK's `ai.prompt.messages`), span names (`chat {model}` vs `ai.streamText.doStream` vs v7 `chat {model}`), tool-call representation (FINDINGS §1.4).

---

## 3. Hook strategy (ranked)

### Tier 1 (default, primary): patch `globalThis.fetch`, match provider hosts

Match `api.anthropic.com` (`POST /v1/messages`) and `api.openai.com` (`POST /v1/chat/completions`); pass everything else through untouched. Span per matched request: start before dispatch from the parsed JSON body (request attrs), end on response completion (response/usage attrs) — same span lifecycle as OpenLLMetry's wrapped-method shape (FINDINGS §2).

Why first — every documented failure mode from FINDINGS §7 that kills the other tiers doesn't apply:
- **F1 (import-before-init / ESM hoisting):** irrelevant — `globalThis.fetch` is patched at preload time regardless of what the app imported when.
- **F2 (bundler require-rewriting):** irrelevant — no module resolution involved; bundled apps still call `globalThis.fetch`.
- **F3 (import-in-the-middle fragility, missing hook.mjs, Node version gates):** no loader hooks used.
- **F4 (bundling renames prototypes/internals):** no prototype paths touched.
- **F7 (per-API-surface coverage + SDK semver ranges going stale):** the wire format changes far more slowly than SDK class layouts; one hook covers all SDK versions, including `baseURL`-compatible proxies if we extend the matcher.
- **Bun:** this is the channel-independent choice. FINDINGS §7 flags that Sentry's preferred mechanism (undici `diagnostics_channel`) is unproven on Bun since Bun's fetch isn't undici; a direct fetch patch sidesteps that entirely (verified by Test B's Bun leg).

Known risks, inherited from the references:
- *User-overwritten fetch* — Sentry explicitly isolates core behavior from mechanisms "users may overwrite" (FINDINGS §7, `SentryNodeFetchInstrumentation.ts:50-55`). Mitigation: patch as late as possible at preload, keep a re-check (`fetch !== ourWrapper`) in `init()`, warn once if displaced.
- *SDK not using global fetch* — if `@anthropic-ai/sdk`/`openai` use a custom dispatcher or injected `fetch`, tier 1 sees nothing. Not established by Phase 1 → **Q2**, verified empirically by Test B before any fallback work.
- *Body teeing must be behavior-preserving* — Test B's byte-identical criterion exists for this.

Streaming at the fetch tier: tee `response.body` (`ReadableStream.tee()`), return one branch untouched to the caller, parse the other as SSE. For Anthropic, accumulate usage exactly as OpenLLMetry does from in-band events — `message_start` carries initial usage, `message_delta` the final output tokens, merged with `Object.assign` semantics (FINDINGS §4, anthropic L352-393); FINDINGS §4 explicitly confirms the same data is wire-visible, so fetch-tier token counts equal SDK-tier counts. End the span when the SSE stream closes; on stream error: ERROR status + `recordException` + end + rethrow (same as anthropic L428-436). For OpenAI streams, usage is only in-band when the caller sets `stream_options.include_usage`; otherwise we emit the span **without usage** rather than mutate the request or bundle a tokenizer (OpenLLMetry tiktoken-estimates instead, openai L698-719 — see Q3 for whether we adopt that).

### Tier 2 (opt-in): SDK prototype patching, OpenLLMetry pattern

The classes from FINDINGS §2: `_wrap("create")` on `Anthropic.Messages.prototype` / `OpenAI.Chat.Completions.prototype`, stream re-wrapping that preserves `APIPromise`/`Stream` types (anthropic L439-453, openai `_thenUnwrap` L791-849). Two activation paths, both bypassing loader hooks:
- `init({ instrumentModules: { anthropic } })` → `manuallyInstrument(module)` — the documented Next.js/webpack workaround (raw/1A §1A.8).
- Tier 3 hooks (below) when explicitly enabled.

When to use: only when fetch-tier data is insufficient (e.g. SDK-level retries where the app sees one call but the wire sees three, or providers reached through non-fetch transports). It inherits F1/F2/F4/F7, which is exactly why it's second.

### Tier 3 (last resort): module-load interception

`InstrumentationNodeModuleDefinition` via require-in-the-middle/import-in-the-middle — the layer both reference repos document as the fragile one (FINDINGS §7 F1–F5; Sentry's nuxt/solidstart/nextjs workaround code exists *because* of this layer). Never enabled by default; only via `AGENTGRAPH_INSTRUMENT_SDKS=true` on the preload, with the Sentry-style try/catch-warn around `module.register()` (`esmLoader.ts:27-31`).

### 3.4 Tier dedup

If tier 2 wraps a call that internally uses fetch, two spans would result. The tier-2 wrapper runs its body under `context.with(ctx.setValue(SUPPRESS_FETCH_SPAN_KEY, true), ...)`; the fetch hook checks the active context and skips span creation when set. Same mechanism as OpenLLMetry's `suppressTracing` context usage (`decorators.ts:88-90`) and their `CONTEXT_KEY_ALLOW_TRACE_CONTENT` per-call override pattern (raw/1A §1A.4). Requires a working context manager under Bun → Q1.

### 3.5 Context propagation for `withAgent()`

Verbatim OpenLLMetry mechanism (FINDINGS §3):
1. Context keys via `createContextKey` (`AGENT_ID_KEY`, `CONVERSATION_ID_KEY`, `CHANNEL_TYPE_KEY`) — model: `tracing/tracing.ts:7-13`.
2. `withAgent(opts, fn)`: derive context with the keys set, `context.with(ctx, () => tracer.startActiveSpan(`${agentId}.agent`, {}, ctx, span => ...))` — model: `decorators.ts:33-192`. Parent span gets the `agentgraph.*` attrs directly.
3. An `onStart`-wrapping span processor reads the keys from `context.active()` and stamps `agentgraph.*` onto **every** span started inside, including tier-1/tier-2 LLM spans — model: `span-processor.ts:156-225`. This is what makes `init({agentId})`-only setups work too: when no context key is present, fall back to the global agentId from config.

---

## 4. Content capture toggle

Mirror `TRACELOOP_TRACE_CONTENT` (FINDINGS §7 last block; raw/1A §1A.4), fixing their two bugs:

- `AGENTGRAPH_TRACE_CONTENT` (default `"true"`), read in exactly one place: `shouldSendContent()` in core — `config.traceContent === false || env === "false"` → off. Model: `tracing/index.ts:375-380`.
- Resolution order per span: context-key override → config → default true. Model: `_shouldSendPrompts()` (anthropic L571-583).
- When off, drop **only**: `gen_ai.input.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`, `gen_ai.output.messages`. Keep: model, request params, response id/model, finish_reasons, all usage tokens — Traceloop's explicit "metadata, not content" line (raw/1A §1A.4).
- Bug fixes vs reference: the check lives in **core**, consulted by every emission path (fetch tier, SDK tier, `withLLMCall` manual API) — OpenLLMetry forgot to propagate the global toggle to its Anthropic instrumentation (`tracing/index.ts:283-311`) and skips gating entirely in `manual.ts`; centralizing in core makes both impossible.

---

## 5. Open questions

| # | Question | Answered by |
|---|---|---|
| Q1 | **ANSWERED YES (M5, 2026-06-12).** Does our provider setup (BasicTracerProvider + ALS context manager + OTLP proto exporter) run cleanly under Bun, and does `context.with` propagate across Bun's async boundaries (needed for §3.4/§3.5)? — Test B bun-preload leg (Bun 1.3.14): spans exported to Jaeger over OTLP proto, attribute-complete, streaming usage accumulated. `scripts/test-b/q1-context-probe.ts` under Bun: `withAgent`/`withConversation` context keys survive an awaited timer hop and are stamped by the onStart processor. | Test B Bun leg + Q1 context probe (`npm run test:b`); reference: sentry `packages/bun/src/sdk.ts:42-43` (what Sentry ships on Bun) |
| Q2 | **ANSWERED — LATE-BOUND (M5, 2026-06-12), for `@anthropic-ai/sdk`.** `@anthropic-ai/sdk@0.104.1` calls `globalThis.fetch` at request time on Node 24 AND Bun 1.3.14: the preload-installed fetch hook captured every SDK request (non-streaming and streaming) in Test B. **Consequence (M6 decision point): tier 1 is sufficient for the Anthropic SDK — tier 2 stays opt-in.** `openai` not yet verified empirically (Test B is Anthropic-only by design); verify when an openai leg or Test A exercises it. | Empirical: Test B (`npm run test:b`); source: anthropics/anthropic-sdk-typescript `src/core.ts` fetch resolution + openai-node equivalent (not cloned in Phase 1) |
| Q3 | OpenAI streaming usage at fetch tier: accept missing usage, inject `stream_options.include_usage` (request mutation — behavior risk), or tiktoken-estimate like OpenLLMetry (`instrumentation-openai/src/instrumentation.ts:698-719`, heavyweight dep)? v0 ships "missing"; decide before GA | openllmetry-js openai instrumentation L592-789; OpenAI API docs |
| Q4 | `agentgraph.agent.fingerprint` definition (⚠️ invention): is hash(provider, model, tool names, system-prompt prefix) stable enough across prompt-template interpolation? Needs real traffic to validate clustering quality | Our own Test B traces; no reference repo answers this |
| Q5 | Content-level equivalence mapping `ai.prompt.messages` (AI SDK v6) → `gen_ai.input.messages` JSON shape — needed only if the graph layer reads message content, not for Test C's query contract | ai@6.0.116 `stringifyForTelemetry` (raw/1C §1C.2) vs openllmetry `packages/instrumentation-utils/src/message-formatters.ts:95-142` |
| Q6 | Should `withAgent` also emit Traceloop-compatible `traceloop.workflow.name`/`gen_ai.agent.name` for ecosystem interop (Traceloop UI, etc.)? Zero cost via the same processor | openllmetry `span-processor.ts:196-198`; decision is product, not technical |
| Q7 | AI SDK v7 forward-compat: when ai-chatbot upgrades, native spans become `invoke_agent`/`chat`/`execute_tool` via `@ai-sdk/otel` with telemetry **opt-out** — does the Test C query contract (§2.3) hold unmodified? FINDINGS §1.4 says yes for the v7 `OpenTelemetry` integration (it emits `gen_ai.provider.name`/`gen_ai.request.model`/`gen_ai.usage.*`), but unverified against a running v7 app | ai repo `packages/otel/src/open-telemetry.ts:252-296,432-496` |

---

## 6. Acceptance: verification test plan (Phase 3)

**Shared infra.** `docker compose up` a Jaeger all-in-one: OTLP HTTP on `4318`, UI on `16686`. All tests pass/fail by inspecting Jaeger (UI for eyeballing, `GET /api/traces?service=...` for assertions and fixture export).

### Test A — repo WITH native telemetry (vercel/ai-chatbot)

Setup (all facts from FINDINGS §8/Test A facts):
1. `instrumentation.ts` already registers `@vercel/otel` (`ai-chatbot/instrumentation.ts:1-5`) — no new file. Point it at Jaeger via env only: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (vercel/otel appends `/v1/traces`, default protocol `http/protobuf`).
2. Flip `app/(chat)/api/chat/route.ts:237` from `isEnabled: isProductionEnvironment` to `isEnabled: true` (telemetry is opt-in in ai@6; dev mode otherwise emits nothing).
3. Run with the default model `moonshotai/kimi-k2.5` (reasoning models disable tools via `experimental_activeTools: []`, `route.ts:199-201`). Requires Vercel AI Gateway credentials — flagged dependency.
4. Send one chat message: **"What's the weather in San Francisco?"** → triggers `getWeather` (`lib/ai/tools/get-weather.ts:32`).

Pass criteria:
- One trace for the turn containing: `ai.streamText` root span; ≥2 child `ai.streamText.doStream` spans with `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (set at `[v6] stream-text.ts:1651-1662, 1990-1998`); one `ai.toolCall` span with `ai.toolCall.name="getWeather"`.
- Parenting matches the FINDINGS §8 tree: doStream spans are children of the root, toolCall under step 1's doStream; no orphan spans.
- Timestamps sane: root duration ≥ sum of network time; step 2 starts after the toolCall ends.
- Export the trace JSON from Jaeger (`/api/traces/{traceID}`) → commit as `research/fixtures/test-a-reference.json`.

### Test B — repo WITHOUT telemetry (bare app + our shim)

Scaffold `test-apps/bare/`: plain Node/TS HTTP server, no OTel imports anywhere, two endpoints using `@anthropic-ai/sdk` directly — `POST /chat` (`messages.create`, non-streaming) and `POST /chat-stream` (`stream: true`). No AI SDK, no framework. Also runnable under Bun.

Tier 0 (zero code changes):
```sh
NODE_OPTIONS="--import @agentgraph/register" AGENTGRAPH_ENDPOINT=http://localhost:4318 node server.ts
```

Pass criteria:
1. Both endpoints produce `chat {model}` spans in Jaeger with `gen_ai.provider.name="anthropic"`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`/`output_tokens`, and (content on) `gen_ai.input.messages`/`gen_ai.output.messages`.
2. Streaming endpoint reports **final** token counts (accumulated from `message_start`/`message_delta` per FINDINGS §4) — equal to the non-streaming endpoint's counts for an identical prompt within provider variance.
3. `AGENTGRAPH_TRACE_CONTENT=false` removes the four content attributes (§4) but keeps usage/model/finish_reasons.
4. **No behavioral interference:** capture both endpoints' full HTTP responses (status, headers minus date-variant ones, body bytes; for the stream, the exact SSE byte sequence) with and without the preload — must be byte-identical. This is the F6/teeing regression gate.
5. **Bun leg:** `bun --preload @agentgraph/register server.ts` (or Bun's NODE_OPTIONS equivalent) — the fetch-level hook still produces spans even if module interception doesn't. Answers Q1/Q2.

One-line tier: remove the preload; add `init({ agentId: "test-agent" })` as the first import-time call of the entrypoint. Pass: all spans (both endpoints) carry `agentgraph.agent.id="test-agent"`.

### Test C — equivalence check

Run the §2.3 query contract as a script against both Jaeger result sets (Test A's AI SDK spans, Test B's shim spans):
- `isLLMCall` selects exactly the LLM spans in both (A: the doStream spans; B: the `chat {model}` spans), zero false positives.
- `provider()` and `usage()` return well-formed values for every selected span via the **same code path** — no `if (source === ...)` branches beyond the documented `gen_ai.provider.name ?? gen_ai.system` coalesce.
- If the consumer would need different code paths for the two sources, the §2 schema mapping is wrong: fix it here, re-run A and B.
- Commit the query script as the executable definition of the contract (it becomes the graph layer's ingestion predicate).
