# Phase 1 Research Findings

Synthesized from three reference repos, cloned shallow into `workspace/` on 2026-06-10:

| Repo | Role | Checkout |
|---|---|---|
| `workspace/openllmetry-js` (traceloop/openllmetry-js) | Primary architecture reference | main @ 28c4a7a |
| `workspace/sentry-javascript` (getsentry/sentry-javascript) | DX + module-interception reference | main, shallow |
| `workspace/ai-chatbot` (vercel/ai-chatbot) + `workspace/ai` (vercel/ai) | Instrumented test target | ai-chatbot pins `ai@6.0.116`; `ai` repo is v7-canary |

Full per-question reports with extended extracts: `research/raw/1A-openllmetry-js.md`, `research/raw/1B-sentry-javascript.md`, `research/raw/1C-ai-chatbot-ai-sdk.md`. All file paths below are relative to the respective repo root inside `workspace/`.

**Three findings that change Phase 2 assumptions — read these first:**

1. **openllmetry-js has migrated to OTel GenAI semconv ≥1.40.** Its auto-instrumentations emit `gen_ai.provider.name` (not `gen_ai.system`) and JSON-blob `gen_ai.input.messages` / `gen_ai.output.messages` (not flattened `gen_ai.prompt.<i>.role/content`). The flattened style survives only in their manual API (openllmetry-js `packages/traceloop-sdk/src/lib/tracing/manual.ts:94-142`).
2. **The AI SDK (v6, what ai-chatbot runs) emits the *older* semconv style on its doStream/doGenerate spans:** `gen_ai.system`, `gen_ai.request.*`, `gen_ai.usage.input_tokens/output_tokens` (ai@6.0.116 `src/generate-text/stream-text.ts:1651-1662, 1990-1998`, extracted from the npm tarball sourcemap). So Test C's equivalence query must target the intersection: `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` are present in both worlds; the "system/provider" key differs (`gen_ai.system` vs `gen_ai.provider.name`).
3. **AI SDK v7 (current `ai` main) removes built-in OTel emission entirely** — it dispatches lifecycle events and span emission moves to `@ai-sdk/otel` with *opt-out* telemetry and new span names (`invoke_agent`/`chat`/`execute_tool`) (ai `packages/ai/src/telemetry/create-telemetry-dispatcher.ts:62-183`, `packages/otel/src/open-telemetry.ts:252-296`, `content/docs/08-migration-guides/23-migration-guide-7-0.mdx:380-477`). Our schema mapping must tolerate three generations of AI SDK span shapes.

---

## 1. Span attribute schema table

### 1.1 OpenLLMetry auto-instrumentation LLM spans

Span name: `` `${operation} ${model}` `` (e.g. `chat claude-3-5-sonnet-latest`), `SpanKind.CLIENT` — anthropic `packages/instrumentation-anthropic/src/instrumentation.ts:305-308`, openai `packages/instrumentation-openai/src/instrumentation.ts:521-524`.

OTel constants imported from `@opentelemetry/semantic-conventions/incubating` `^1.40.0` (`packages/instrumentation-anthropic/package.json:44`); Traceloop-custom constants in `packages/ai-semantic-conventions/src/SemanticAttributes.ts:18-108`.

| Attribute | Origin | Content-gated? | Set at (anthropic / openai `src/instrumentation.ts`) |
|---|---|---|---|
| `gen_ai.provider.name` (`anthropic`, `openai`, `azure.ai.openai`, `aws.bedrock`, …) | OTel | no | A:L249 / O:L449 (vendor from `client.baseURL`, O:L1073-1119) |
| `gen_ai.operation.name` (`chat`, `text_completion`) | OTel | no | A:L250 / O:L450 |
| `gen_ai.request.model` | OTel | no | A:L254 / O:L454 |
| `gen_ai.request.temperature`, `.top_p` | OTel | no | A:L255-256 / O:L459-462 |
| `gen_ai.request.top_k` | OTel | no | A:L257 only |
| `gen_ai.request.max_tokens` | OTel | no | A:L269/272 / O:L456 |
| `gen_ai.request.frequency_penalty`, `.presence_penalty` | OTel | no | O:L465-470 only |
| `gen_ai.input.messages` — JSON `[{role, parts:[{type:"text",content}]}]` (format: `packages/instrumentation-utils/src/message-formatters.ts:95-142`) | OTel | **yes** | A:L291-297 / O:L490-513 |
| `gen_ai.system_instructions` — JSON parts array | OTel | **yes** | A:L286-289 only (OpenAI folds system into input.messages, O:L485-487) |
| `gen_ai.tool.definitions` — JSON | OTel | **yes** | O:L493-506 only |
| `gen_ai.output.messages` — JSON `[{role:"assistant", finish_reason, parts}]` | OTel | **yes** | A:L548-561 / O:L902-928 |
| `gen_ai.response.model` | OTel | no | A:L509 / O:L876 |
| `gen_ai.response.id` | OTel | no | O:L877-879 only |
| `gen_ai.response.finish_reasons` (array; mapped from provider stop reasons) | OTel | no ("metadata not content", A:L511) | A:L512-516 / O:L896-900 |
| `gen_ai.usage.input_tokens`, `.output_tokens` | OTel | no | A:L523-530 / O:L885-892 |
| `gen_ai.usage.cache_creation.input_tokens`, `.cache_read.input_tokens` | OTel 1.40 | no | A:L533-544 only |
| `gen_ai.usage.total_tokens` | Traceloop (`SemanticAttributes.ts:57`) | no | A:L519-522 / O:L881-884 |
| `gen_ai.request.thinking_type`, `.thinking.budget_tokens` | Traceloop (`SemanticAttributes.ts:47-50`) | no | A:L262-265 |
| `llm.request.type` | Traceloop back-compat (`SemanticAttributes.ts:55`) | — | only in manual API (`manual.ts:153,181`) |

### 1.2 Traceloop workflow/entity attributes (SDK-emitted, `traceloop.*`)

Defined `packages/ai-semantic-conventions/src/SemanticAttributes.ts:95-103`; set in `packages/traceloop-sdk/src/lib/tracing/decorators.ts:102-128` and injected onto **all child spans** by the span processor `packages/traceloop-sdk/src/lib/tracing/span-processor.ts:156-225`:

`traceloop.span.kind` (workflow|task|agent|tool), `traceloop.workflow.name`, `traceloop.entity.name`, `traceloop.entity.path`, `traceloop.entity.version`, `traceloop.entity.input`/`output` (JSON, content-gated), `traceloop.association.properties.<key>`, plus OTel `gen_ai.agent.name` (span-processor.ts:196-198) and `gen_ai.conversation.id` (L203-206). This processor-injection pattern is the direct model for our `agentgraph.*` namespace.

### 1.3 AI SDK v6 spans (what ai-chatbot emits when enabled)

Tracer `trace.getTracer('ai')` (`ai@6.0.116 src/telemetry/get-tracer.ts:4-20`). Per-span attributes — see span tree in §8 for placement:

- All spans: `operation.name` = `"<operationId> <functionId>"`, `resource.name`, `ai.operationId`, `ai.telemetry.functionId` (`ai/packages/otel/src/assemble-operation-name.ts:3-21`, identical in v6).
- Base: `ai.model.provider`, `ai.model.id`, `ai.settings.*`, `ai.telemetry.metadata.<key>` (user metadata!), `ai.request.headers.*` (`[v6] src/telemetry/get-base-telemetry-attributes.ts:16-52`).
- Root `ai.streamText`: `ai.prompt` (JSON of {system,prompt,messages}); finish: `ai.response.finishReason/text/reasoning/toolCalls/providerMetadata`, `ai.usage.inputTokens/outputTokens/totalTokens/reasoningTokens/cachedInputTokens` (`[v6] src/generate-text/stream-text.ts:1276-1290, 1143-1169`).
- `ai.streamText.doStream`: `ai.prompt.messages`, `ai.prompt.tools`, `ai.prompt.toolChoice`, **`gen_ai.system`, `gen_ai.request.{model,frequency_penalty,max_tokens,presence_penalty,stop_sequences,temperature,top_k,top_p}`** (start, L1651-1662); finish: `ai.response.*`, `ai.usage.*`, **`gen_ai.response.finish_reasons/id/model`, `gen_ai.usage.input_tokens/output_tokens`** (L1952-1998). Events `ai.stream.firstChunk` / `ai.stream.finish` (L1758-1763, 1855-1858).
- `ai.toolCall`: `ai.toolCall.name/id/args/result` (`[v6] src/generate-text/execute-tool-call.ts:79-95`).
- Input/output gating: `recordInputs:false` / `recordOutputs:false` skip wrapped attributes; everything returns `{}` unless `isEnabled === true` (`[v6] src/telemetry/select-telemetry-attributes.ts:23-71`).

### 1.4 Schema reconciliation (the Test C contract)

| Concept | OpenLLMetry (semconv 1.40) | AI SDK v6 | AI SDK v7 `@ai-sdk/otel` `OpenTelemetry` |
|---|---|---|---|
| provider | `gen_ai.provider.name` | `gen_ai.system` | `gen_ai.provider.name` (`ai/packages/otel/src/open-telemetry.ts:252-296`) |
| request model | `gen_ai.request.model` | `gen_ai.request.model` | `gen_ai.request.model` |
| usage | `gen_ai.usage.input_tokens` / `.output_tokens` | same (doStream/doGenerate spans only) | same |
| prompt content | `gen_ai.input.messages` (JSON) | `ai.prompt.messages` (own ns) | `gen_ai.input.messages` |
| completion content | `gen_ai.output.messages` (JSON) | `ai.response.text` etc. (own ns) | `gen_ai.output.messages` |
| tool call | (no tool span; tool defs on request) | `ai.toolCall` span | `execute_tool {name}` span |

→ "Find LLM calls" is queryable across all three by `gen_ai.request.model` + `gen_ai.usage.input_tokens` presence. Provider key needs a one-line coalesce (`gen_ai.provider.name ?? gen_ai.system`). Content keys do NOT line up between AI SDK v6 and GenAI conventions — equivalence at the content level requires mapping `ai.prompt.messages` → `gen_ai.input.messages` shape (flag for DESIGN.md).

---

## 2. Instrumentation class skeleton (OpenLLMetry pattern)

From `packages/instrumentation-anthropic/src/instrumentation.ts` (annotated; full extract in raw/1A §1A.1):

```ts
export class AnthropicInstrumentation extends InstrumentationBase {        // L89
  constructor(config: AnthropicInstrumentationConfig = {}) {               // L92
    super("@traceloop/instrumentation-anthropic", version, config);        // L93
  }

  // Escape hatch: patch a module object the app already imported (no loader hook)
  public manuallyInstrument(module: typeof anthropic) { ...same _wrap calls... }  // L100-118

  protected init(): InstrumentationModuleDefinition {                      // L120
    return new InstrumentationNodeModuleDefinition(
      "@anthropic-ai/sdk", [">=0.9.1"],                                    // L122-123 module + semver range
      this.patch.bind(this), this.unpatch.bind(this));                     // L124-125
  }

  private patch(moduleExports: typeof anthropic) {                         // L130
    // messages.create interception = wrap the *prototype* of the resource class:
    this._wrap(moduleExports.Anthropic.Messages.prototype, "create",       // L141-145
      this.patchAnthropic("chat", moduleExports));
    // also Completions.prototype and Beta.Messages.prototype (L133-150)
    return moduleExports;
  }

  private patchAnthropic(type, moduleExports) {                            // L165
    const plugin = this;
    return (original) => function method(this: any, ...args) {             // L174-175
      const span = plugin.startSpan({ type, params: args[0] });            // L176-189 span from request params, BEFORE call
      const execContext = trace.setSpan(context.active(), span);           // L191
      const execPromise = safeExecuteInTheMiddle(
        () => context.with(execContext, () => original.apply(this, args)), ...);  // L192-205
      if (args[0].stream) {                                                // L208
        return context.bind(execContext,
          plugin._streamingWrapPromise(this._client, moduleExports, { span, type, promise: execPromise }));  // L215-222
      }
      return context.bind(execContext, plugin._wrapPromise(type, span, execPromise));  // L225-227
    };
  }
  // _wrapPromise: .then(result => this._endSpan({span, result}))
  //               .catch(err => { span.setStatus(ERROR); span.recordException(err); span.end(); throw err; })  // L456-491
}
```

OpenAI variant identical in structure (`packages/instrumentation-openai/src/instrumentation.ts:135, 201-209, 227-236, 310-418`); module def is `("openai", [">=4 <7"])`; extra care to return a real `APIPromise` via `_thenUnwrap` (O:L791-849).

## 3. Context propagation pattern (`withWorkflow` → our `withAgent`)

OpenLLMetry uses **pure OTel context API** — no direct AsyncLocalStorage (the ALS lives inside the OTel ContextManager). `packages/traceloop-sdk/src/lib/tracing/decorators.ts:33-192` (`withEntity`, the core all wrappers delegate to):

1. Build a derived context: `context.active().setValue(WORKFLOW_NAME_KEY, name)` (+ `AGENT_NAME_KEY`, `ENTITY_NAME_KEY` with dotted nesting `parent.child`, `CONVERSATION_ID_KEY`, `ASSOCATION_PROPERTIES_KEY`, optional per-call content-capture override key) — decorators.ts:51-90; keys created via `createContextKey` in `tracing/tracing.ts:7-13`.
2. `context.with(entityContext, () => getTracer().startActiveSpan(`${name}.${type}`, {}, entityContext, async span => { ... fn.apply(...) ... span.end() }))` — decorators.ts:92-188. Sets `traceloop.span.kind/workflow.name/entity.name/entity.path` + content-gated `traceloop.entity.input/output` JSON.
3. **Child-span stamping happens in the span processor, not by inheritance**: `span-processor.ts:156-225` — a wrapped `onStart` reads the context keys off `context.active()` and stamps `traceloop.workflow.name`, `traceloop.entity.path`, `gen_ai.agent.name`, `gen_ai.conversation.id`, `traceloop.association.properties.*` onto *every* span started inside that context, including auto-instrumented LLM spans.

This (context key + onStart processor stamping) is exactly the mechanism for `agentgraph.agent.id` / `agentgraph.conversation.id` reaching LLM spans without touching the instrumentation layer.

Manual-reporting escape hatch (no patching at all): `withLLMCall({vendor,type}, fn)` hands the callback an `LLMSpan` with `reportRequest({model,messages})` / `reportResponse({model,usage,completions})` (`packages/traceloop-sdk/src/lib/tracing/manual.ts:73-201`). Caveat: it uses the *old* flattened `gen_ai.prompt.<i>.*` schema and skips content gating.

## 4. Streaming pattern

Both OpenLLMetry instrumentations tee by **re-yielding chunks through an async generator while accumulating a synthetic final result**; span ends only when the stream is fully consumed; iteration errors set ERROR status + recordException + end + rethrow.

- **Anthropic (the pattern to copy)** — token counts come from the stream's own usage events, no tokenizer: `message_start` → `Object.assign(result.usage, chunk.message.usage)`; `message_delta` → merge `chunk.usage` (final output_tokens); `content_block_start/delta` accumulate content (`packages/instrumentation-anthropic/src/instrumentation.ts:352-393`, `_endSpan` at L395). To keep the caller's object a real SDK `Stream`, it rebuilds an `APIPromise` from the original's internals and re-wraps with `new realStream.constructor(() => iterateStream(realStream), realStream.controller)` (L439-453).
- **OpenAI** — returns a bare async generator (not a rebuilt Stream) and **estimates** streamed token usage with js-tiktoken (`enrichTokens`, `packages/instrumentation-openai/src/instrumentation.ts:592-789, 698-719, 1050-1071`); it does not use `stream_options.include_usage`. OpenAI Responses-API streaming is not instrumented at all (span closed with request attrs only, L366-385).

Implication for us: for Anthropic `messages.create({stream:true})`, final token counts are available in-band (`message_start` + `message_delta`) — same data is visible at the fetch/SSE layer, so a fetch-level hook can produce identical usage numbers.

## 5. Init / preload pattern

### OpenLLMetry `initialize()` (single-call SDK init)

`packages/traceloop-sdk/src/lib/configuration/index.ts:27-107` → `startTracing()` `packages/traceloop-sdk/src/lib/tracing/index.ts:270-359`, in order: (1) env defaulting (`TRACELOOP_BASE_URL`, `TRACELOOP_API_KEY`, appName ← `npm_package_name`); (2) instrumentation registration — default: construct all 14 instrumentations; if `instrumentModules` given: skip hooks entirely and `manuallyInstrument(module)` each (index.ts:277-282, 157-175); (3) content-toggle propagation; (4) exporter = `options.exporter` ?? `OTLPTraceExporter` (**OTLP/HTTP protobuf**) at `${baseUrl}/v1/traces` with `Authorization: Bearer` header (L313-326); (5) span processor = `disableBatch ? Simple : Batch` + monkey-patched `onStart`/`onEnd` (`span-processor.ts:96-137`); (6) resource with service name; (7) `new NodeSDK({resource, spanProcessors, contextManager, textMapPropagator, traceExporter, instrumentations}).start()` (L347-358). Full `InitializeOptions`: `interfaces/initialize-options.interface.ts:20-156` (`appName`, `apiKey`, `baseUrl`, `disableBatch`, `traceContent`, `exporter`, `headers`, `processor`, `propagator`, `contextManager`, `instrumentModules`, `logLevel`, …).

### Sentry init + preload (the DX model)

`Sentry.init()` (`packages/node/src/sdk/index.ts:42-70` → `packages/node-core/src/sdk/index.ts:95-157`): resolve options/env → **register ESM loader hook** (`initializeEsmLoader`) → set OTel async-context strategy → construct client → `client.init()` runs all integrations' `setupOnce`/`setup` → then OTel provider/propagator/context-manager registration (`packages/node/src/sdk/initOtel.ts:86-111`) + debug-only `validateOpenTelemetrySetup()`.

Preload entries (package.json `exports`):
- `--import @sentry/node/init` — calls `init()` configured purely from env vars (`packages/node/src/init.ts:1-9`).
- `--import @sentry/node/preload` — registers loader hooks + preloads instrumentations *without* initializing the SDK; env `SENTRY_PRELOAD_INTEGRATIONS`, `SENTRY_DEBUG` (`packages/node/src/preload.ts:1-20`, `initOtel.ts:52-69`).
- ESM hook = `node:module`'s `register('import-in-the-middle/hook.mjs', …, { data: { addHookMessagePort, include: [] } })`, guarded by `GLOBAL_OBJ._sentryEsmLoaderHookRegistered`, wrapped in try/catch that only warns (`packages/node-core/src/sdk/esmLoader.ts:12-31`). CJS path: OTel `InstrumentationBase` / require-in-the-middle via `registerInstrumentations` (`packages/node-core/src/otel/instrument.ts:63-65`).
- Late-init detection: `ensureIsWrapped` checks OTel `isWrapped()` on framework fns and console-warns with remediation (`packages/node-core/src/utils/ensureIsWrapped.ts:18-48`).

Our `@agentgraph/register` should mirror: an entry module whose top-level side effect installs hooks + inits from env (`AGENTGRAPH_ENDPOINT` etc.), idempotency-guarded via a global flag, all failures non-fatal warnings.

## 6. Integration interface (Sentry)

`packages/core/src/types/integration.ts:6-68`:

```ts
export interface Integration {
  name: string;
  setupOnce?(): void;                     // once per process — monkey patching lives here
  beforeSetup?(client: Client): void;
  setup?(client: Client): void;           // per-client; preferred
  afterAllSetup?(client: Client): void;
  preprocessEvent?(event, hint, client): void;
  processEvent?(event, hint, client): Event | null | PromiseLike<Event | null>;
  processSpan?(span: StreamedSpanJSON, client: Client): void;
  processSegmentSpan?(span: StreamedSpanJSON, client: Client): void;
}
```

- Declared via identity helper `defineIntegration(fn)` (`packages/core/src/integration.ts:170-172`).
- Defaults: `defaultIntegrations: options.defaultIntegrations ?? getDefaultIntegrations(options)`; `false` disables all (`packages/node/src/sdk/index.ts:49-70`, `core/src/integration.ts:49`).
- Dedup by `name`, last wins, but a default never overwrites a user instance (`core/src/integration.ts:25-43`); `integrations:` array is appended after defaults, or a function receives defaults and returns the final list (L46-69).
- Setup: `setupOnce` gated by a module-level `installedIntegrations` list; `setup(client)` per client; event/span processors registered as client hooks (L77-152).

## 7. Known failure modes — what NOT to depend on

Consolidated from both repos (full list with 20 citations in raw/1B §1B.5):

| # | Failure mode | Evidence |
|---|---|---|
| F1 | Target lib imported before init ⇒ require/import hooks never fire. ESM import hoisting makes this the *default* failure in ESM apps | sentry `packages/node/README.md:24-25`, `docs/v8-node.md:38-42`; traceloop troubleshooting docs ("import traceloop before any other LLM libraries") |
| F2 | Bundlers (Next.js/webpack) inline/rewrite `require` ⇒ module hooks see nothing | traceloop force-instrumentations doc ("issues with Next.js and some configurations of Webpack"); `instrumentModules` JSDoc `packages/traceloop-sdk/src/lib/interfaces/initialize-options.interface.ts:86-89`; sentry-nextjs must externalize auto-instrumented packages (`packages/nextjs/src/config/withSentryConfig/constants.ts:1-3`) |
| F3 | `module.register()`/import-in-the-middle: not statically analyzable ⇒ hook.mjs missing from bundles; loader can break other libs (TS path aliases, openllmetry issue #469); needs Node ≥18.19/20.6 | sentry `packages/nuxt/src/vite/addServerConfig.ts:190-196`, `packages/node-core/src/types.ts:92-100` (+ `registerEsmLoaderHooks:false` escape hatch), `packages/node-core/src/utils/detection.ts:28-37` |
| F4 | Bundling hides submodules / renames internals ⇒ prototype paths and private fields vanish | sentry langchain (`packages/node/src/integrations/tracing/langchain/instrumentation.ts:77-79`), prisma `_idGenerator` hack (`tracing/prisma/index.ts:86-100`), Bun `--bytecode` renaming (`tracing/InstrumentationNodeModuleFile.ts:16-21`) |
| F5 | Double-init when both auto-injection and `--import` are used | sentry `packages/nuxt/src/common/types.ts:200-202` |
| F6 | SDK-prototype patching breaks rich return types unless carefully rebuilt (`APIPromise`, `Stream`) | openllmetry anthropic `_streamingWrapPromise` L439-453; openai `_thenUnwrap` L791-849 |
| F7 | Patching coverage is per-API-surface: openllmetry doesn't instrument OpenAI Responses streaming; SDK version ranges (`>=4 <7`) go stale | openai instrumentation L366-385, L201-209 |

**Robust mechanisms (Sentry's direction, Bun-relevant):** outgoing fetch is instrumented **exclusively via `diagnostics_channel`** — `undici:request:create/headers/trailers/error` subscriptions, zero module interception (`init()` returns undefined) — vendored UndiciInstrumentation `packages/node/src/integrations/node-fetch/vendored/undici.ts:88-91, 120-124`; the **Bun SDK reuses exactly this integration** (`packages/bun/src/sdk.ts:42-43`). node:http likewise uses `http.client.request.created` / `http.server.request.start` channels on Node ≥22.12, falling back to patching `http.request` (`packages/node-core/src/integrations/http/SentryHttpInstrumentation.ts:22-25, 216-247`; fallback `packages/core/src/integrations/http/client-patch.ts:40-70`).

⚠️ Open verification item: Sentry relies on the *runtime emitting* undici diagnostics channels. Whether Bun emits `undici:*` channels is not established by this research (Bun implements fetch natively, not via undici) — Test B's Bun leg must verify; a `globalThis.fetch` patch is the channel-independent alternative.

Content-capture gating reference (`TRACELOOP_TRACE_CONTENT`): env read once in `shouldSendTraces()` (`packages/traceloop-sdk/src/lib/tracing/index.ts:375-380`, default true); per-instrumentation `_shouldSendPrompts()` checks a context key first, then config (`instrumentation-anthropic/src/instrumentation.ts:571-583`); when off, only message/tool-definition content attrs are dropped — model, params, finish_reasons, and all usage tokens are kept. Bug worth not repeating: their global toggle propagation forgets the Anthropic instrumentation (`tracing/index.ts:283-311`).

## 8. AI SDK span tree (one chat turn with a tool call, ai@6.0.116, telemetry enabled)

Scenario: "What's the weather in San Francisco?" → `getWeather` tool → continuation step. (Citations `[v6]` = ai@6.0.116 original sources via npm sourcemap; structure confirmed by `ai/content/docs/03-ai-sdk-core/60-telemetry.mdx:652-687`.)

```
ai.streamText                                  [v6] stream-text.ts:1276-1290
│  operation.name="ai.streamText stream-text", ai.operationId, ai.telemetry.functionId,
│  ai.model.provider/id, ai.settings.*, ai.prompt={system,prompt,messages} JSON
│  finish: ai.response.finishReason/text/toolCalls, ai.usage.{input,output,total,reasoning,cachedInput}Tokens
│
├── ai.streamText.doStream        (step 1)     [v6] stream-text.ts:1623-1666
│   │  ai.prompt.messages, ai.prompt.tools, ai.prompt.toolChoice,
│   │  gen_ai.system, gen_ai.request.{model,max_tokens,temperature,top_p,top_k,...}      [1651-1662]
│   │  events: ai.stream.firstChunk, ai.stream.finish                                    [1758-1763, 1855-1858]
│   │  finish: ai.response.* , gen_ai.response.finish_reasons=["tool-calls"],
│   │          gen_ai.response.id/model, gen_ai.usage.input_tokens/output_tokens         [1952-1998]
│   └── ai.toolCall                            [v6] execute-tool-call.ts:79-95 (unawaited: run-tools-transformation.ts:333-343)
│          ai.toolCall.name="getWeather", ai.toolCall.id, ai.toolCall.args, ai.toolCall.result
│
└── ai.streamText.doStream        (step 2)     finish_reasons=["stop"], final text
```

N steps ⇒ N sibling `doStream` spans under one root. Tool spans parent under their step's doStream (explicit in v7 code: `ai/packages/otel/src/legacy-open-telemetry.ts:587-592, 614-618`). Nested `streamText` inside tools (ai-chatbot's `createDocument` etc.) appears as a nested `ai.streamText` subtree under the `ai.toolCall` — only if telemetry is enabled on the nested call too.

### Test A enablement facts (ai-chatbot)

- 10 AI SDK call sites in 6 files; only the main chat route has `experimental_telemetry` and it's gated `isEnabled: isProductionEnvironment` (`app/(chat)/api/chat/route.ts:236-239`, `lib/constants.ts:3`). One-line change to `isEnabled: true` for dev. Other 9 sites need the option added if their spans are wanted (full table: raw/1C §1C.1). Title generation (`app/(chat)/actions.ts:28`) is fire-and-forget ⇒ separate root trace.
- `instrumentation.ts` already exists with `registerOTel({ serviceName: "chatbot" })` (`ai-chatbot/instrumentation.ts:1-5`); `@vercel/otel ^1.12.0` already a dep (`package.json:23`); Next 16 needs no `instrumentationHook` flag.
- Exporter via env only, no code: `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` (SDK appends `/v1/traces`; default protocol `http/protobuf`, `http/json` selectable, grpc unsupported) — verified in vercel/otel `packages/otel/src/sdk.ts` (Env type L62-72, `buildExporterUrlFromEnv` L524-536).
- Tool to trigger: `getWeather` (`lib/ai/tools/get-weather.ts:32`) — "What's the weather in San Francisco?". Caveats: models come from Vercel AI Gateway (`lib/ai/providers.ts:17-23`, needs gateway credentials); reasoning models without tool support set `experimental_activeTools: []` (`route.ts:199-201`) — pick the default `moonshotai/kimi-k2.5`.

---

## Carry-forward notes for DESIGN.md (Phase 2)

1. Hook ranking support: fetch-level hook avoids F1–F5 entirely; SDK-prototype patching (tier 2) inherits F1/F2 unless offered `manuallyInstrument`-style; module-load interception (tier 3) is the documented fragile layer in both reference repos.
2. Schema: adopt semconv-1.40 style (`gen_ai.provider.name`, `gen_ai.input/output.messages`) as primary, but the Test C query layer must coalesce `gen_ai.system` and map `ai.prompt.*`/`ai.usage.*` from AI SDK v6 spans.
3. Anthropic streaming usage is recoverable at the wire level (SSE `message_start`/`message_delta`) — fetch-tier instrumentation loses nothing for token counts.
4. Unverified assumptions to test, not assume: Bun's emission of `undici:*` diagnostics channels; byte-identical app behavior under stream teeing.
