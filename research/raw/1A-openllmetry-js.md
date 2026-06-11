# Raw research findings: openllmetry-js (traceloop/openllmetry-js, main @ 28c4a7a)

All paths relative to repo root `workspace/openllmetry-js`. Important global caveat: this checkout is the **post-migration codebase that uses OTel GenAI semconv 1.40** (`gen_ai.input.messages` / `gen_ai.output.messages` JSON attributes, `gen_ai.provider.name`). It does **not** use the older `gen_ai.prompt.<i>.role/content` flattened attributes in the auto-instrumentations (those only survive in the manual API, see 1A.7).

## 1A.1 Instrumentation base pattern

Both classes extend `InstrumentationBase` from `@opentelemetry/instrumentation` directly (no generic parameter), call `super(name, version, config)`, implement `init()` returning an `InstrumentationNodeModuleDefinition`, and patch via `this._wrap` / `this._unwrap` on **class prototypes** exposed by the module exports.

### Anthropic — `packages/instrumentation-anthropic/src/instrumentation.ts`

- Class declaration: line 89 `export class AnthropicInstrumentation extends InstrumentationBase {`
- Constructor: lines 92–94, `super("@traceloop/instrumentation-anthropic", version, config)` (version imported from `../package.json`, line 64).
- `init()`: lines 120–128 — `InstrumentationNodeModuleDefinition("@anthropic-ai/sdk", [">=0.9.1"], this.patch.bind(this), this.unpatch.bind(this))`.
- Patch targets (lines 130–152): `_wrap` of `"create"` on three prototypes:
  - `moduleExports.Anthropic.Completions.prototype` (text_completion type)
  - `moduleExports.Anthropic.Messages.prototype` (chat type) ← this is how `messages.create` is wrapped: the SDK's `client.messages` is an instance of `Anthropic.Messages`, so wrapping `Messages.prototype.create` intercepts `messages.create()`.
  - `moduleExports.Anthropic.Beta.Messages.prototype` (chat type)
- Unpatch (lines 154–163): `_unwrap` on the same three prototypes.

Annotated skeleton:

```ts
// instrumentation-anthropic/src/instrumentation.ts
export class AnthropicInstrumentation extends InstrumentationBase {        // L89
  declare protected _config: AnthropicInstrumentationConfig;               // L90

  constructor(config: AnthropicInstrumentationConfig = {}) {               // L92
    super("@traceloop/instrumentation-anthropic", version, config);       // L93
  }

  public manuallyInstrument(module: typeof anthropic) { ... }              // L100-118 (same _wrap calls as patch())

  protected init(): InstrumentationModuleDefinition {                      // L120
    const module = new InstrumentationNodeModuleDefinition(                // L121
      "@anthropic-ai/sdk",                                                 // L122  module name
      [">=0.9.1"],                                                         // L123  version range
      this.patch.bind(this),                                               // L124
      this.unpatch.bind(this),                                             // L125
    );
    return module;                                                         // L127
  }

  private patch(moduleExports: typeof anthropic, moduleVersion?: string) { // L130
    this._wrap(moduleExports.Anthropic.Completions.prototype, "create",    // L133-140
      this.patchAnthropic(GEN_AI_OPERATION_NAME_VALUE_TEXT_COMPLETION, moduleExports));
    this._wrap(moduleExports.Anthropic.Messages.prototype, "create",       // L141-145  <-- messages.create
      this.patchAnthropic(GEN_AI_OPERATION_NAME_VALUE_CHAT, moduleExports));
    this._wrap(moduleExports.Anthropic.Beta.Messages.prototype, "create",  // L146-150
      this.patchAnthropic(GEN_AI_OPERATION_NAME_VALUE_CHAT, moduleExports));
    return moduleExports;                                                  // L151
  }
```

The patch function (the wrapped-method shape), lines 165–230:

```ts
  private patchAnthropic(type, moduleExports) {                            // L165
    const plugin = this;                                                   // L172
    return (original: Function) => {                                       // L174  _wrap wrapper factory
      return function method(this: any, ...args: unknown[]) {              // L175  replaces Messages.prototype.create
        const span = plugin.startSpan({ type, params: args[0] ... });      // L176-189  span started BEFORE the call, from request params
        const execContext = trace.setSpan(context.active(), span);         // L191
        const execPromise = safeExecuteInTheMiddle(                        // L192
          () => context.with(execContext, () => {
            if ((args?.[0] as any)?.extraAttributes) delete (args[0] as any).extraAttributes;  // L195-197 strip non-API param
            return original.apply(this, args);                             // L198  call real create()
          }), (e) => { if (e) plugin._diag.error(...); });                 // L201-205
        if ((args[0] as ...).stream) {                                     // L208-214
          return context.bind(execContext,
            plugin._streamingWrapPromise(this._client, moduleExports,      // L215-222  `this._client` is the Anthropic client of the Messages instance
              { span, type, promise: execPromise }));
        }
        const wrappedPromise = plugin._wrapPromise(type, span, execPromise); // L225
        return context.bind(execContext, wrappedPromise as any);           // L227
      };
    };
  }
```

`_wrapPromise` (lines 456–491) calls `.then(result => this._endSpan({type, span, result}))` and `.catch(error => { span.setStatus(ERROR); span.recordException(error); span.end(); throw error; })`.

### OpenAI — `packages/instrumentation-openai/src/instrumentation.ts`

- Class: line 135 `export class OpenAIInstrumentation extends InstrumentationBase {`; constructor lines 138–140 `super("@traceloop/instrumentation-openai", version, config)`.
- `init()`: lines 201–209 — `InstrumentationNodeModuleDefinition("openai", [">=4 <7"], this.patch.bind(this), this.unpatch.bind(this))`.
- `patch()` (lines 211–278) has a v3 branch: if `(moduleExports as any).OpenAIApi` exists (openai v3.1.0) it wraps `OpenAIApi.prototype.createChatCompletion` and `OpenAIApi.prototype.createCompletion` (lines 215–225). Otherwise (v4+):
  - `moduleExports.OpenAI.Chat.Completions.prototype`, `"create"` → `patchOpenAI(GEN_AI_OPERATION_NAME_VALUE_CHAT)` (lines 227–231). This is how `chat.completions.create` is intercepted — the prototype of the `Chat.Completions` resource class.
  - `moduleExports.OpenAI.Completions.prototype`, `"create"` → text_completion (lines 232–236).
  - `Responses.prototype.create` (Responses API) if present, via `getResponsesClass()` helper (lines 128–133, 238–245).
  - `moduleExports.OpenAI.Images.prototype` `"generate"`, `"edit"`, `"createVariation"` via separate wrappers from `./image-wrappers` (lines 247–275).
- `unpatch()` (lines 280–308) `_unwrap`s all of the above.
- The wrapped-method shape (`patchOpenAI`, lines 310–418) is identical in structure to Anthropic's: start span from `args[0]` params (lines 322–345), `safeExecuteInTheMiddle` + `context.with(execContext, () => original.apply(this, args))` (lines 347–362), stream branch (lines 364–406; Responses-API streaming is *not* instrumented — span closed with request attrs only, lines 366–385), non-stream `_wrapPromise(type, version, span, execPromise)` (lines 408–415), all returns wrapped in `context.bind(execContext, ...)`.
- OpenAI-specific: `_wrapPromise` uses the OpenAI SDK's `APIPromise._thenUnwrap` (lines 791–849, type defined lines 83–85) so the returned object remains an `APIPromise` (preserving `.withResponse()` etc.) instead of a plain `Promise`.
- OpenAI-specific: `_detectVendorFromURL(client)` (lines 1073–1119) inspects `client.baseURL` to set provider to azure/bedrock/vertex/gemini/openrouter/openai.

## 1A.2 Streaming handling

Both packages **tee the stream by re-yielding chunks through an async generator while accumulating a synthetic final result object**; the span is ended only after the stream is fully consumed. Token counts:

- **Anthropic**: token usage comes from the stream's own usage events — `message_start` carries `chunk.message.usage` and `message_delta` carries `chunk.usage`; they are merged with `Object.assign`. No tokenizer estimation. `packages/instrumentation-anthropic/src/instrumentation.ts:352-393`:

```ts
for await (const chunk of stream) {                       // L352
  yield chunk;                                            // L353  pass-through to caller
  switch (chunk.type) {                                   // L356
    case "message_start":                                 // L357
      result.id = chunk.message.id;
      result.model = chunk.message.model;
      Object.assign(result.usage, chunk.message.usage);   // L360  input/output token counts from usage event
      break;
    case "message_delta":                                 // L362
      if (chunk.usage) Object.assign(result.usage, chunk.usage);  // L363-365  final output_tokens
      break;
    case "content_block_start":                           // L367  accumulate content blocks
      ...
    case "content_block_delta":                           // L373  concatenate text deltas
      ...
  }
}
this._endSpan({ span, type, result });                    // L395
```

- **Anthropic's wrapping mechanism is the more elaborate one**: because the Anthropic SDK returns an `APIPromise<Stream<...>>` whose resolved value must remain a real `Stream` (with `.controller`, `.tee()`, etc.), `_streamingWrapPromise` (lines 311–454) constructs a **new `moduleExports.APIPromise`** reusing the original promise's internal `responsePromise`/`parseResponse`, then rebuilds the stream with the same constructor around the instrumented iterator (lines 439–453):

```ts
return new moduleExports.APIPromise(
  client,                                                  // L440  (this._client captured in patchAnthropic, L217)
  (promise as any).responsePromise,                        // L441
  async (client, props) => {
    const realStream = await (promise as any).parseResponse(client, props);  // L443
    // take the incoming stream, iterate it using our instrumented function, and wrap it in a new stream to keep the rich object type the same
    return new realStream.constructor(
      () => iterateStream.call(this, realStream),          // L447
      realStream.controller,                               // L448
    );
  },
);
```

  Errors during iteration set span status ERROR, record exception, end span, and rethrow (lines 428–436).

- **OpenAI**: `_streamingWrapPromise` (lines 592–789) is itself an `async *` generator returned directly to the caller (line 397–405) — i.e. the caller gets a bare async generator, **not** a rebuilt `Stream` instance (difference vs. Anthropic). It accumulates a synthetic `ChatCompletion` (lines 611–628), concatenating `delta.content` (line 642–644), `delta.function_call` (645–655), and indexed `delta.tool_calls` fragments (656–691). Chunk loop:

```ts
for await (const chunk of await promise) {                 // L629
  yield chunk;                                             // L630
  result.id = chunk.id; result.created = chunk.created; result.model = chunk.model;  // L632-634
  if (chunk.choices[0]?.finish_reason) result.choices[0].finish_reason = ...;        // L636-638
  if (chunk.choices[0]?.delta.content)
    result.choices[0].message.content += chunk.choices[0].delta.content;             // L642-644
  ...tool_calls accumulation L656-691
}
```

- **OpenAI streamed token counts are *estimated via tokenizer***, not taken from usage chunks: gated by config `enrichTokens` (default true via env `TRACELOOP_ENRICH_TOKENS`, see SDK `packages/traceloop-sdk/src/lib/tracing/index.ts:58-59` — note the `types.ts` JSDoc says `@default false` but the SDK passes `true` unless env says otherwise). Lines 698–719:

```ts
if (this._config.enrichTokens) {                           // L698
  let promptTokens = 0;
  for (const message of params.messages) {
    promptTokens += this.tokenCountFromString(message.content as string, result.model) ?? 0;  // L700-706
  }
  const completionTokens = this.tokenCountFromString(result.choices[0].message.content ?? "", result.model);  // L708-711
  if (completionTokens) {
    result.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens,
                     total_tokens: promptTokens + completionTokens };   // L713-717
  }
}
this._endSpan({ span, type, result });                     // L721
```

  `tokenCountFromString` uses `js-tiktoken` `encodingForModel` with an encoding cache (lines 1050–1071; import line 80). Notably it does **not** read `chunk.usage` (OpenAI's `stream_options.include_usage`) — usage is purely tiktoken-estimated for streams.
- OpenAI **Responses API streaming is explicitly not instrumented**: span is closed with request attributes only; the original stream is returned untouched (lines 366–385 incl. comment).

## 1A.3 Span attribute schema

Span name format and kind (both instrumentations): `` `${operation} ${model}` `` — e.g. `chat claude-3-5-sonnet-latest`, `chat gpt-4o`, `text_completion gpt-3.5-turbo-instruct` — with `SpanKind.CLIENT`:
- anthropic: `instrumentation.ts:305-308` — `this.tracer.startSpan(`${type} ${params?.model ?? "unknown"}`, { kind: SpanKind.CLIENT, attributes })`
- openai: `instrumentation.ts:521-524` and (Responses) `583-589`.

Workflow/task spans (SDK) are named `` `${name}.${type}` `` e.g. `myflow.workflow` (`packages/traceloop-sdk/src/lib/tracing/decorators.ts:94`) with default (INTERNAL) SpanKind.

Constants come from two places:
1. **OTel GenAI semconv** — imported from `@opentelemetry/semantic-conventions/incubating` (`^1.40.0`, see `packages/instrumentation-anthropic/package.json:44`, `packages/instrumentation-openai/package.json:43`). Not vendored in repo; string values verified against the published `@opentelemetry/semantic-conventions@1.40.0` build.
2. **Traceloop-custom** — `packages/ai-semantic-conventions/src/SemanticAttributes.ts` (`SpanAttributes` object, lines 18–108).

| Constant | String value | Origin | Set where |
|---|---|---|---|
| `ATTR_GEN_AI_PROVIDER_NAME` | `gen_ai.provider.name` (values `anthropic`, `openai`, `azure.ai.openai`, `aws.bedrock`, `gcp.vertex_ai`, `gcp.gemini`, `gcp.gen_ai`, `openrouter`) | OTel | anthropic L249; openai L449 (chat/completion, via `_detectVendorFromURL` L1073-1119), L536 (responses) |
| `ATTR_GEN_AI_OPERATION_NAME` | `gen_ai.operation.name` (values `chat`, `text_completion`) | OTel | anthropic L250; openai L450, L537 |
| `ATTR_GEN_AI_REQUEST_MODEL` | `gen_ai.request.model` | OTel | anthropic L254; openai L454, L541 |
| `ATTR_GEN_AI_REQUEST_TEMPERATURE` | `gen_ai.request.temperature` | OTel | anthropic L255; openai L459, L546 |
| `ATTR_GEN_AI_REQUEST_TOP_P` | `gen_ai.request.top_p` | OTel | anthropic L256; openai L462, L549 |
| `ATTR_GEN_AI_REQUEST_TOP_K` | `gen_ai.request.top_k` | OTel | anthropic L257 only |
| `ATTR_GEN_AI_REQUEST_MAX_TOKENS` | `gen_ai.request.max_tokens` | OTel | anthropic L269/L272 (`max_tokens_to_sample` for completion, `max_tokens` for chat); openai L456, L543 (`max_output_tokens` for responses) |
| `ATTR_GEN_AI_REQUEST_FREQUENCY_PENALTY` | `gen_ai.request.frequency_penalty` | OTel | openai L465-466 only |
| `ATTR_GEN_AI_REQUEST_PRESENCE_PENALTY` | `gen_ai.request.presence_penalty` | OTel | openai L469-470 only |
| `ATTR_GEN_AI_INPUT_MESSAGES` | `gen_ai.input.messages` (JSON array of `{role, parts:[{type:"text",content},...]}` — format contract in `packages/instrumentation-utils/src/message-formatters.ts:95-142`) | OTel | anthropic L291-297; openai L490-491, L508-513, L574-576. Content-gated. |
| `ATTR_GEN_AI_SYSTEM_INSTRUCTIONS` | `gen_ai.system_instructions` (JSON array of parts, no wrapper message — `message-formatters.ts:44-89`) | OTel | anthropic L286-289 only (OpenAI keeps system msgs inside input.messages per comment at openai L485-487). Content-gated. |
| `ATTR_GEN_AI_TOOL_DEFINITIONS` | `gen_ai.tool.definitions` (JSON, source format) | OTel | openai L493-506 only (functions + tools). Content-gated. |
| `ATTR_GEN_AI_OUTPUT_MESSAGES` | `gen_ai.output.messages` (JSON array of `{role:"assistant", finish_reason, parts}`) | OTel | anthropic L548-561; openai L902-911 (chat), L919-928 (completion), L974-979 (responses). Content-gated. |
| `ATTR_GEN_AI_RESPONSE_MODEL` | `gen_ai.response.model` | OTel | anthropic L509; openai L876, L940-942 |
| `ATTR_GEN_AI_RESPONSE_ID` | `gen_ai.response.id` | OTel | openai L877-879, L943-945 only |
| `ATTR_GEN_AI_RESPONSE_FINISH_REASONS` | `gen_ai.response.finish_reasons` (array; provider stop_reason mapped via `anthropicFinishReasonMap` anthropic L82-87 / `openaiFinishReasonMap` from `./message-helpers`) | OTel | anthropic L512-516 (always set, "metadata not content"); openai L896-900, L913-917, L971-973 |
| `ATTR_GEN_AI_USAGE_INPUT_TOKENS` | `gen_ai.usage.input_tokens` | OTel | anthropic L527-530; openai L888-892 (`usage.prompt_tokens`), L950 |
| `ATTR_GEN_AI_USAGE_OUTPUT_TOKENS` | `gen_ai.usage.output_tokens` | OTel | anthropic L523-526; openai L885-887 (`usage.completion_tokens`), L953 |
| `ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS` | `gen_ai.usage.cache_creation.input_tokens` | OTel (v1.40) | anthropic L533-538 only |
| `ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS` | `gen_ai.usage.cache_read.input_tokens` | OTel (v1.40) | anthropic L539-544 only |
| `SpanAttributes.GEN_AI_USAGE_TOTAL_TOKENS` | `gen_ai.usage.total_tokens` | Traceloop-custom (`SemanticAttributes.ts:57`; no OTel total-tokens attr) | anthropic L519-522 (input+output sum); openai L881-884, L962-967 |
| `SpanAttributes.GEN_AI_REQUEST_THINKING_TYPE` | `gen_ai.request.thinking_type` | Traceloop-custom (`SemanticAttributes.ts:47`) | anthropic L262-263 (beta thinking) |
| `SpanAttributes.GEN_AI_REQUEST_THINKING_BUDGET_TOKENS` | `gen_ai.request.thinking.budget_tokens` | Traceloop-custom (`SemanticAttributes.ts:49-50`) | anthropic L264-265 |
| (passthrough) `extraAttributes` | arbitrary keys from request param `extraAttributes` | Traceloop mechanism | anthropic L275-282; openai L473-481, L552-567 |
| span **event** `logprobs` | event attr `logprobs` = JSON | Traceloop-custom | openai `_addLogProbsEvent` L1002-1048 |

**Explicitly absent / differs from older schema:** `gen_ai.system` (`ATTR_GEN_AI_SYSTEM`) is *not* used — replaced by `gen_ai.provider.name`. `gen_ai.prompt.<i>.role/content` and `gen_ai.completion.<i>.*` are *not* set by these instrumentations (only by the manual `LLMSpan` API, see 1A.7). `llm.request.type` exists only as a back-compat constant (`SemanticAttributes.ts:55`) and is set only in `manual.ts:153,181`.

Traceloop workflow attributes (set by the SDK, not the provider instrumentations — `SemanticAttributes.ts:95-103`): `traceloop.span.kind`, `traceloop.workflow.name`, `traceloop.entity.name`, `traceloop.entity.path`, `traceloop.entity.version`, `traceloop.association.properties`, `traceloop.entity.input`, `traceloop.entity.output`. Where set: `packages/traceloop-sdk/src/lib/tracing/decorators.ts:102-127, 138-149, 161-164, 177-180` and the span processor `packages/traceloop-sdk/src/lib/tracing/span-processor.ts:156-222` (`onSpanStart` copies `WORKFLOW_NAME_KEY`→`traceloop.workflow.name` L157-163, `ENTITY_NAME_KEY`→`traceloop.entity.path` L165-171, association props as `traceloop.association.properties.<key>` L209-222, plus OTel `gen_ai.agent.name` L196-198 and `gen_ai.conversation.id` L203-206).

## 1A.4 Content capture toggle

Three layers:

1. **Env var read** — `TRACELOOP_TRACE_CONTENT` is read in exactly one place: `packages/traceloop-sdk/src/lib/tracing/index.ts:375-380` inside `shouldSendTraces()`:

```ts
if (
  _configuration.traceContent === false ||
  (process.env.TRACELOOP_TRACE_CONTENT || "true").toLowerCase() === "false"   // L377
) {
  return false;
}
```

   It maps to the SDK config option `traceContent?: boolean` (`packages/traceloop-sdk/src/lib/interfaces/initialize-options.interface.ts:51-55`, default true).

2. **Propagation to instrumentations** — in `startTracing()` (`tracing/index.ts:283-311`): if `!shouldSendTraces()`, it calls `setConfig({ traceContent: false })` on openAI, llamaIndex, vertexai, aiplatform, bedrock, cohere, chromadb, together, genai instrumentations. **Notable gap: `anthropicInstrumentation` is NOT in this list** (nor langchain/pinecone/qdrant/mcp), so the global toggle does not reach the Anthropic instrumentation via config — only via the context-key path or by constructing `AnthropicInstrumentation({traceContent:false})` yourself.

3. **Check at attribute-set time** — each instrumentation has a private `_shouldSendPrompts()`:
   - anthropic `instrumentation.ts:571-583`, openai `instrumentation.ts:988-1000` (identical):

```ts
private _shouldSendPrompts() {
  const contextShouldSendPrompts = context.active()
    .getValue(CONTEXT_KEY_ALLOW_TRACE_CONTENT);          // context key wins (per-workflow override)
  if (contextShouldSendPrompts !== undefined) return contextShouldSendPrompts;
  return this._config.traceContent !== undefined ? this._config.traceContent : true;  // default true
}
```

   `CONTEXT_KEY_ALLOW_TRACE_CONTENT` is `createContextKey("allow_trace_content")` defined at `packages/ai-semantic-conventions/src/index.ts:20-22`; it's set per-entity by the decorator option `traceContent` at `packages/traceloop-sdk/src/lib/tracing/decorators.ts:72-77`.

**Excluded when off** (everything else is kept):
- anthropic: `gen_ai.system_instructions` + `gen_ai.input.messages` (startSpan L284-299) and `gen_ai.output.messages` (`_endSpan` L548-562).
- openai: `gen_ai.input.messages` + `gen_ai.tool.definitions` (L483-515), responses input (L569-577), `gen_ai.output.messages` (L902-911, L919-928, L974-979).
- **Kept regardless**: model/params (request.model, temperature, top_p, top_k, max_tokens, penalties), response.model/id, finish_reasons (explicit comments "it's metadata, not user content" — anthropic L511, openai L896), all usage token attributes incl. cache tokens.
- For workflow spans, `shouldSendTraces()` gates `traceloop.entity.input`/`traceloop.entity.output` (`decorators.ts:130-154, 160-165, 176-181`).

## 1A.5 The init SDK

Entry: `packages/traceloop-sdk/src/lib/node-server-sdk.ts` re-exports `initialize`/`getClient` from `./configuration` (line 81), `forceFlush` (82), decorators (84), manual API (85), etc. Comment at line 93: "Instrumentations are now initialized only when initialize() is called".

`initialize()` — `packages/traceloop-sdk/src/lib/configuration/index.ts:27-107`, in order:
1. Idempotency guard (L28-30).
2. Env defaulting: `baseUrl` ← `TRACELOOP_BASE_URL` or `https://api.traceloop.com` (L32-35); `apiKey` ← `TRACELOOP_API_KEY` (L36-38); `appName` ← `process.env.npm_package_name` (L39-41); `experimentSlug` ← `TRACELOOP_EXP_SLUG` (L42-44); traceloopSync* env defaults (L46-71).
3. `validateConfiguration(options)` (L73; impl `configuration/validation.ts:4-44`).
4. Freeze `_configuration` (L75), print "Traceloop exporting traces to …" unless `silenceInitializationMessage` (L77-83).
5. If `tracingEnabled !== false`: set diag logger from `logLevel` (L86-91), then **`startTracing(_configuration)`** (L93).
6. `initializeRegistry(_configuration)` (prompt registry, L96); if `apiKey`, construct singleton `TraceloopClient` and return it (L97-105).

`startTracing()` — `packages/traceloop-sdk/src/lib/tracing/index.ts:270-359`, in order:
1. Resolve apiKey/baseUrl (L271-275).
2. **Instrumentation registration**: if `options.instrumentModules` has any keys → `manuallyInitInstrumentations(...)` (L277-278) which clears the default list (L157) and, per provided module, constructs the instrumentation and calls its `manuallyInstrument(moduleInstance)` (e.g. openAI L159-167, anthropic L169-175; langchain always enabled L215-219). Otherwise → `initInstrumentations(apiKey, baseUrl)` (L280-282) which constructs **all 14** instrumentations (OpenAI with `enrichTokens` + `uploadBase64Image` callback L69-85; Anthropic L87-92; Cohere, VertexAI, AIPlatform, Bedrock, Pinecone, LangChain, LlamaIndex, ChromaDB, Qdrant, Together, MCP, Google GenAI L94-134) into the module-level `instrumentations` array (L52).
3. Content-toggle propagation via `setConfig({traceContent:false})` (L283-311, see 1A.4).
4. Headers: `options.headers` || parsed `TRACELOOP_HEADERS` || `{Authorization: Bearer ${apiKey}}` (L313-317).
5. **Exporter**: `options.exporter` ?? (`gcpProjectId` ? `GcpTraceExporter` : `new OTLPTraceExporter({url: `${baseUrl}/v1/traces`, headers})`) (L319-326). The OTLP exporter is **`@opentelemetry/exporter-trace-otlp-proto`** i.e. OTLP/HTTP protobuf (import L4).
6. **Span processor**: `createSpanProcessor({...disableBatch...})` (L328-335; impl `span-processor.ts:96-137`): `disableBatch ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter)` (`span-processor.ts:113-115`), then monkey-patches `onStart` (workflow/entity/agent/conversation/association attribute injection from context, L120, L156-225) and `onEnd` (instrumentation-library filtering + AI-SDK transformations + agent-name inheritance + OTel v1/v2 span compat shim, L122-134, L270-317). An optional extra `options.processor` is appended (L337-340).
7. **Resource**: service name = `appName || npm_package_name || "unknown_service"` via version-compat `createResource` (L342-345, L390-401).
8. **NodeSDK assembly and start** (L347-358):

```ts
_sdk = new NodeSDK({
  resource,
  spanProcessors,
  contextManager: options.contextManager,   // L350  passed through; OTel SDK default if undefined
  textMapPropagator: options.propagator,    // L351
  traceExporter,
  instrumentations,                         // L353  the array built above
});
_sdk.start();                               // L358
```

**Full `InitializeOptions`** — `packages/traceloop-sdk/src/lib/interfaces/initialize-options.interface.ts:20-156`: `appName?`, `apiKey?`, `baseUrl?` (note: it's `baseUrl`, not `apiEndpoint`), `disableBatch?`, `logLevel?`, `traceContent?`, `exporter?: SpanExporter`, `headers?: Record<string,string>`, `processor?: SpanProcessor`, `propagator?: TextMapPropagator`, `contextManager?: ContextManager`, `instrumentModules?: { openAI?, anthropic?, cohere?, bedrock?, google_vertexai?, google_aiplatform?, pinecone?, together?, langchain?: boolean, llamaIndex?, llamaIndexOpenAI?, chromadb?, qdrant?, mcp?, google_genai? }` (L90-107), `traceloopSyncEnabled?`, `traceloopSyncMaxRetries?`, `traceloopSyncPollingInterval?`, `traceloopSyncDevPollingInterval?`, `silenceInitializationMessage?`, `tracingEnabled?`, `experimentSlug?`, `gcpProjectId?`. The `instrumentModules` JSDoc (L86-89) reads: "Explicitly specify modules to instrument. Optional. This is a workaround specific to Next.js, see https://www.traceloop.com/docs/openllmetry/getting-started-nextjs".

## 1A.6 Workflow/task decorators

File: `packages/traceloop-sdk/src/lib/tracing/decorators.ts`. Exposed as functional wrappers `withWorkflow`/`withTask`/`withAgent`/`withTool` (L194-244) and TS method decorators `workflow`/`task`/`agent`/`tool` (L281-311), plus `withConversation`/`conversation` (L313-361). All delegate to the core `withEntity` (L33-192).

Context propagation: **pure OTel context API** — `context.setValue(...)` on custom context keys + `context.with(...)` + `tracer.startActiveSpan(...)`. **No AsyncLocalStorage is used directly** (the ALS lives inside whatever OTel ContextManager the NodeSDK installs). Context keys are defined in `packages/traceloop-sdk/src/lib/tracing/tracing.ts:7-13` (`WORKFLOW_NAME_KEY = createContextKey("workflow_name")`, `ENTITY_NAME_KEY`, `AGENT_NAME_KEY`, `CONVERSATION_ID_KEY`, `ASSOCATION_PROPERTIES_KEY` [sic]).

Workflow name reaches **child spans** via the span processor, not inheritance of attributes: `span-processor.ts:156-163` (`onSpanStart` reads `WORKFLOW_NAME_KEY` from `context.active()` and sets `traceloop.workflow.name` on *every* span started inside that context, including LLM spans from the instrumentations); entity path similarly via `ENTITY_NAME_KEY` → `traceloop.entity.path` (L165-171).

Core wrapper extract (`decorators.ts`):

```ts
function withEntity(type, {name, version, associationProperties, conversationId,
    traceContent: overrideTraceContent, inputParameters, suppressTracing: shouldSuppressTracing}, fn, thisArg, ...args) {  // L33-50
  let entityContext = context.active();                                       // L51
  if (type === WORKFLOW || type === AGENT)
    entityContext = entityContext.setValue(WORKFLOW_NAME_KEY, name);          // L52-57
  if (type === AGENT) entityContext = entityContext.setValue(AGENT_NAME_KEY, name);  // L59-61
  const entityPath = getEntityPath(entityContext);                            // L63
  if (type === TOOL || type === TASK) {
    const fullEntityName = entityPath ? `${entityPath}.${name}` : name;       // L68  nested path "parent.child"
    entityContext = entityContext.setValue(ENTITY_NAME_KEY, fullEntityName);  // L69
  }
  if (overrideTraceContent != undefined)
    entityContext = entityContext.setValue(CONTEXT_KEY_ALLOW_TRACE_CONTENT, overrideTraceContent);  // L72-77
  if (associationProperties) entityContext = entityContext.setValue(ASSOCATION_PROPERTIES_KEY, associationProperties);  // L78-83
  if (conversationId) entityContext = entityContext.setValue(CONVERSATION_ID_KEY, conversationId);  // L84-86
  if (shouldSuppressTracing) entityContext = suppressTracing(entityContext);  // L88-90

  return context.with(entityContext, () =>                                    // L92
    getTracer().startActiveSpan(`${name}.${type}`, {}, entityContext,         // L93-96  span name e.g. "myflow.workflow"
      async (span: Span) => {
        if (type === WORKFLOW || type === AGENT)
          span.setAttribute(SpanAttributes.TRACELOOP_WORKFLOW_NAME, name);    // L98-103  traceloop.workflow.name
        span.setAttribute(SpanAttributes.TRACELOOP_ENTITY_NAME, name);        // L104
        span.setAttribute(SpanAttributes.TRACELOOP_ENTITY_PATH, entityPath || "");  // L105-108
        span.setAttribute(SpanAttributes.TRACELOOP_SPAN_KIND, type);          // L109  workflow|task|agent|tool
        ... ATTR_GEN_AI_AGENT_NAME (L112-115), ATTR_GEN_AI_CONVERSATION_ID (L118-124),
            TRACELOOP_ENTITY_VERSION (L126-128)
        if (shouldSendTraces()) {                                             // L130
          span.setAttribute(SpanAttributes.TRACELOOP_ENTITY_INPUT,
            serialize({ args: [...], kwargs: {...} }));                       // L132-150
        }
        const res = fn.apply(thisArg, args);                                  // L156
        if (res instanceof Promise) {
          return res.then((resolvedRes) => {
            if (shouldSendTraces())
              span.setAttribute(SpanAttributes.TRACELOOP_ENTITY_OUTPUT, serialize(resolvedRes));  // L160-165
            span.end();                                                       // L169
            return resolvedRes;
          });
        }
        ... sync path same (L175-188)
      }));
}
```

Entity input/output attributes: `traceloop.entity.input` = `JSON.stringify({args, kwargs})` (single-object args become `kwargs`, L132-150) and `traceloop.entity.output` = serialized return value (L160-165 / L176-181), both gated by `shouldSendTraces()`. `serialize`/`cleanInput` handle Maps/nested objects (L363-384).

## 1A.7 Manual instrumentation escape hatch

Yes, it exists: `packages/traceloop-sdk/src/lib/tracing/manual.ts`, exported from `node-server-sdk.ts:85` (`export * from "./tracing/manual"`).

- `withLLMCall({vendor, type}, fn)` (L176-201): starts a span named `` `${vendor}.${type}` ``, sets `SpanAttributes.LLM_REQUEST_TYPE` (`llm.request.type`, L181), passes an `LLMSpan` wrapper into `fn`, ends the span when the (possibly async) fn resolves.
- `LLMSpan` (L73-144):
  - `reportRequest({model, messages})` (L80-103): sets `gen_ai.request.model` and **old-style indexed prompt attributes** `gen_ai.prompt.<i>.role|content` (L94-102) — the *only* place the indexed prompt schema is used in this repo.
  - `reportResponse({model, usage, completions})` (L105-143): sets `gen_ai.response.model`, `gen_ai.usage.input_tokens`/`output_tokens` + Traceloop `llm.usage.total_tokens` (L126-132), and `gen_ai.completion.<i>.finish_reason|role|content` (L134-142).
- There is also `withVectorDBCall` + `VectorSpan.reportQuery/reportResults` (L29-71, L146-174) for vector DBs.
- Caveat: `manual.ts` does not consult `shouldSendTraces()` before setting prompt/completion content in `LLMSpan` (only `VectorSpan.reportQuery` partially does, L37-39) — content gating is not applied to the manual LLM API.
- (The repo's `CLAUDE.md` "Manual Instrumentation" example mentioning `trace.withLLMSpan` does not match the actual API; the real function is `withLLMCall`.)

Separately, each instrumentation class has the **`manuallyInstrument(module)`** patch-without-require-hook escape hatch (see 1A.8).

## 1A.8 Known ESM/bundler issues

**In-repo evidence:**
- `initialize-options.interface.ts:86-89`: `instrumentModules` JSDoc — "This is a workaround specific to Next.js, see https://www.traceloop.com/docs/openllmetry/getting-started-nextjs".
- Root `README.md:15` links the Next.js getting-started guide.
- The wiring: `startTracing` (`tracing/index.ts:277-282`) — if any `instrumentModules` key is present, `manuallyInitInstrumentations(options.instrumentModules, apiKey, baseUrl)` runs **instead of** the require-hook path; it clears the default instrumentation array (`instrumentations.length = 0`, L157) and for each provided module constructs the instrumentation and calls `manuallyInstrument`, e.g. L159-167:

```ts
if (instrumentModules?.openAI) {
  openAIInstrumentation = new OpenAIInstrumentation({ enrichTokens, exceptionLogger, uploadBase64Image: uploadBase64ImageCallback });
  instrumentations.push(openAIInstrumentation);
  openAIInstrumentation.manuallyInstrument(instrumentModules.openAI);   // L166
}
if (instrumentModules?.anthropic) { ... anthropicInstrumentation.manuallyInstrument(instrumentModules.anthropic); }  // L169-175
```

- `manuallyInstrument` implementations: anthropic `packages/instrumentation-anthropic/src/instrumentation.ts:100-118` (wraps `module.Anthropic.Completions.prototype.create`, `module.Anthropic.Messages.prototype.create`, `module.Anthropic.Beta.Messages.prototype.create` — same wraps as `patch()` but applied to the user-supplied module object instead of via `InstrumentationNodeModuleDefinition`'s require-in-the-middle hook); openai `packages/instrumentation-openai/src/instrumentation.ts:146-199` (wraps `module.Chat.Completions.prototype.create`, `module.Completions.prototype.create`, optional `Responses.prototype.create`, `Images.prototype` methods — note it takes the `OpenAI` *class* (`typeof openai.OpenAI`, interface L91), so prototype paths drop the leading `OpenAI.` compared to `patch()`).
- The repo's own docs/READMEs contain **no explicit ESM/import-hoisting discussion**; nothing in `packages/*/README.md` mentions ESM/webpack beyond boilerplate (verified by grep).

**Official docs (WebFetch):**
- Troubleshooting page (https://www.traceloop.com/docs/openllmetry/troubleshooting): documents the import-order failure mode — "make sure to import traceloop before any other LLM libraries. This is because traceloop needs to instrument the libraries you're using, and it can only do that if it's imported first" — and points to the manual-instrumentation guide for the `instrumentModules` workaround.
- Force-instrumentations page (https://www.traceloop.com/docs/openllmetry/tracing/js-force-instrumentations): "Some customers have reported issues with automatic instrumentations on some environments. … Specifically, we have seen issues with **Next.js and some configurations of Webpack**." Recommended fix is passing module objects via `instrumentModules` at init; "You won't need this on most environments. We recommend trying without it first."
- Next.js guide (https://www.traceloop.com/docs/openllmetry/getting-started-nextjs): "Make sure to explicitly pass any LLM modules you want to instrument as otherwise auto-instrumentation won't work on Next.js"; also requires `disableBatch: true`, and for Pages Router a webpack `node-loader` config for `.node` files + ignoring OTel server-side warnings; App Router variant mentions `node-loader` and `@esbuild-kit/cjs-esm`.

**GitHub issues (`gh search issues`):** only one directly relevant hit — issue #469 (closed) "[Bug] ESM `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` breaks typescript path aliases": using the OTel ESM loader hook (`tsx --experimental-loader=@opentelemetry/instrumentation/hook.mjs`) breaks TS path-alias resolution. Issue #613 (open) is Next.js + AI SDK streaming-duration related, not an instrumentation-failure bug. Searches for "webpack", "no traces", "vite/esbuild", "instrumentModules" in issues returned nothing else.

**Mechanism summary** (why it fails): auto-instrumentation relies on `InstrumentationNodeModuleDefinition` (require-in-the-middle / import-in-the-middle hooks registered when `NodeSDK.start()` runs in `tracing/index.ts:358`). This breaks when (a) the target lib is imported (and ESM-hoisted) before `initialize()` runs, (b) a bundler (Next.js/webpack) rewrites/inlines `require` so the hook never sees the module, or (c) ESM without the experimental loader. The supported workaround is `instrumentModules` → `manuallyInstrument(module)`, which patches the prototypes of the exact module object the app itself imported, bypassing the loader hooks entirely.

**Additional noteworthy finding** (relevant to content gating): the global `TRACELOOP_TRACE_CONTENT`/`traceContent:false` propagation in `startTracing` omits the Anthropic instrumentation (`tracing/index.ts:283-311` — list includes openAI/llamaIndex/vertexai/aiplatform/bedrock/cohere/chromadb/together/genai but not anthropic), so for Anthropic the global off-switch is only effective through the `CONTEXT_KEY_ALLOW_TRACE_CONTENT` context value (set by decorators), not the env var path.
