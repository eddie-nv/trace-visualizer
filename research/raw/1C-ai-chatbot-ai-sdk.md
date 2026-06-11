# Raw research findings: ai-chatbot (vercel/ai-chatbot) + AI SDK (vercel/ai)

Paths prefixed `ai-chatbot/` or `ai/` relative to `workspace/`.

# 1C.1 — AI SDK call sites in ai-chatbot

## Version pinned

`ai-chatbot/package.json:46` pins `"ai": "6.0.116"` (exact, no caret). Also relevant: `"@ai-sdk/react": "3.0.118"` (line 9), `"@opentelemetry/api": "^1.9.0"` (line 14), `"@opentelemetry/api-logs": "^0.200.0"` (line 15), `"@vercel/otel": "^1.12.0"` (line 23), `"next": "16.2.0"` (line 56).

**This is AI SDK v6, not v4 or v5.** In v6 the telemetry API is `experimental_telemetry: { isEnabled, recordInputs, recordOutputs, functionId, metadata, tracer, integrations }` and OTel span emission is **built into the `ai` package** and **opt-in** (`isEnabled: true` required). Verified from the published `ai@6.0.116` typings (npm tarball, `dist/index.d.ts:1103-1141`, `TelemetrySettings`). In v7 (the local `ai` repo checkout) this is reworked — see 1C.2.

## Complete list of call sites

Exactly **10 call sites in 6 files**. **No `streamObject` or `generateObject` calls anywhere** in ai-chatbot (request-suggestions uses `streamText` + `Output.array(...)`).

| # | File:line | Function | Model | experimental_telemetry |
|---|---|---|---|---|
| 1 | `ai-chatbot/app/(chat)/api/chat/route.ts:194` | `streamText` | `getLanguageModel(chatModel)` → Vercel AI Gateway model | **YES** — lines 236–239: `{ isEnabled: isProductionEnvironment, functionId: "stream-text" }`. No metadata, no recordInputs/recordOutputs. |
| 2 | `ai-chatbot/app/(chat)/actions.ts:28` | `generateText` (chat title; called fire-and-forget from route.ts:118) | `getTitleModel()` → `gateway.languageModel("moonshotai/kimi-k2.5")` | NO |
| 3 | `ai-chatbot/artifacts/text/server.ts:11` | `streamText` (onCreateDocument) | `getLanguageModel(modelId)` | NO |
| 4 | `ai-chatbot/artifacts/text/server.ts:35` | `streamText` (onUpdateDocument) | `getLanguageModel(modelId)` | NO |
| 5 | `ai-chatbot/artifacts/code/server.ts:18` | `streamText` (onCreateDocument) | `getLanguageModel(modelId)` | NO |
| 6 | `ai-chatbot/artifacts/code/server.ts:40` | `streamText` (onUpdateDocument) | `getLanguageModel(modelId)` | NO |
| 7 | `ai-chatbot/artifacts/sheet/server.ts:11` | `streamText` (onCreateDocument) | `getLanguageModel(modelId)` | NO |
| 8 | `ai-chatbot/artifacts/sheet/server.ts:33` | `streamText` (onUpdateDocument) | `getLanguageModel(modelId)` | NO |
| 9 | `ai-chatbot/lib/ai/tools/request-suggestions.ts:49` | `streamText` with `output: Output.array(...)` (inside tool execute) | `getLanguageModel(modelId)` | NO |

(Call sites 3–8 are reached through the `createDocument`/`updateDocument` tools.)

The main chat route call, verbatim (`ai-chatbot/app/(chat)/api/chat/route.ts:194-240`):

```ts
const result = streamText({
  model: getLanguageModel(chatModel),
  system: systemPrompt({ requestHints, supportsTools }),
  messages: modelMessages,
  stopWhen: stepCountIs(5),
  experimental_activeTools: ... ["getWeather","createDocument","editDocument","updateDocument","requestSuggestions"],
  providerOptions: { ...(modelConfig?.gatewayOrder && { gateway: { order: modelConfig.gatewayOrder } }), ... },
  tools: { getWeather, createDocument: ..., editDocument: ..., updateDocument: ..., requestSuggestions: ... },
  experimental_telemetry: {
    isEnabled: isProductionEnvironment,
    functionId: "stream-text",
  },
});
```

## Model/provider resolution

- `ai-chatbot/lib/ai/providers.ts:1` — `import { customProvider, gateway } from "ai"`. `getLanguageModel(modelId)` (lines 17–23) returns `gateway.languageModel(modelId)` (Vercel AI Gateway) except in test env (mock provider, lines 5–15). `getTitleModel()` (lines 25–29).
- `ai-chatbot/lib/ai/models.ts:1` — `DEFAULT_CHAT_MODEL = "moonshotai/kimi-k2.5"`; `titleModel` (lines 3–8) has `gatewayOrder: ["fireworks","bedrock"]`. Chat model catalog (lines 28–62): `deepseek/deepseek-v3.2`, `moonshotai/kimi-k2.5`, `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `xai/grok-4.1-fast-non-reasoning`. So `ai.model.provider` will be the gateway provider, `ai.model.id` the gateway slug.

## What must change to enable telemetry on the main chat route

Telemetry is **already wired** but gated:
- `ai-chatbot/lib/constants.ts:3` — `export const isProductionEnvironment = process.env.NODE_ENV === "production";`
- `ai-chatbot/app/(chat)/api/chat/route.ts:237` — `isEnabled: isProductionEnvironment`.

So in `next dev` no spans are emitted (in ai@6, `isEnabled !== true` → noop tracer). To enable:
1. **Main route**: change `route.ts:237` to `isEnabled: true` (or gate on `OTEL_EXPORTER_OTLP_ENDPOINT != null`). `functionId: "stream-text"` already set.
2. **Other call sites**: add `experimental_telemetry: { isEnabled: true, functionId: "<name>" }` to each if wanted. The artifact/suggestion calls execute inside the parent's `ai.toolCall` span context, so when enabled their `ai.streamText` spans nest under the parent trace. Title generation (`actions.ts:28`) runs fire-and-forget → its own root trace.
3. OTel SDK side already present: `ai-chatbot/instrumentation.ts:1-5` registers `@vercel/otel` (see 1C.4).

# 1C.2 — Telemetry implementation in the AI SDK

## Critical version note

The local checkout `ai/` is **`main` at `ai@7.0.0-canary.170`** (`ai/packages/ai/package.json`; depth-1 clone, commit `260caaf`). The expected paths `packages/ai/core/telemetry/` **do not exist**; in v7 the architecture changed:

- v7 `ai` package no longer emits OTel spans itself. It publishes lifecycle **events** through a `TelemetryDispatcher` (`ai/packages/ai/src/telemetry/create-telemetry-dispatcher.ts:62-183`) to registered integrations (`registerTelemetry`, `ai/packages/ai/src/telemetry/telemetry-registry.ts:6-15`, global `globalThis.AI_SDK_TELEMETRY_INTEGRATIONS`) and to a Node diagnostics channel.
- OTel span emission moved to **`@ai-sdk/otel`** (`ai/packages/otel/src/index.ts:1-7` exports `OpenTelemetry` (new GenAI semconv) and `LegacyOpenTelemetry` (v5/v6-compatible spans)). Documented in `ai/content/docs/08-migration-guides/23-migration-guide-7-0.mdx:380-477` ("In AI SDK 6, telemetry was opt-in … In AI SDK 7, telemetry is opt-out").

Because ai-chatbot pins **ai@6.0.116**, the v6 sources were extracted from the published npm tarball's sourcemap (`ai-6.0.116.tgz`, `dist/index.mjs.map` → original `src/**`). Citations marked **[v6]** refer to those original-source paths/lines; **[v7]** to the local repo.

## getTracer / isEnabled gating [v6 — what ai-chatbot actually runs]

`[v6] src/telemetry/get-tracer.ts:4-20` (byte-identical to `ai/packages/otel/src/get-tracer.ts:4-20`):

```ts
export function getTracer({ isEnabled = false, tracer }: { isEnabled?: boolean; tracer?: Tracer } = {}): Tracer {
  if (!isEnabled) { return noopTracer; }
  if (tracer) { return tracer; }
  return trace.getTracer('ai');
}
```

- Tracer name is **`'ai'`**. Caller may override with `experimental_telemetry.tracer` [v6 only; removed in v7 per `23-migration-guide-7-0.mdx:479-511`].
- Double gating: noop tracer when not enabled, **and** `selectTelemetryAttributes` returns `{}` unless `telemetry?.isEnabled === true` (`[v6] src/telemetry/select-telemetry-attributes.ts:23-25`). `recordInputs === false` skips `{ input: () => ... }`-wrapped attributes; `recordOutputs === false` skips `{ output: () => ... }`-wrapped ones (`[v6] select-telemetry-attributes.ts:34-71`; v7 equivalent: `ai/packages/otel/src/legacy-open-telemetry.ts:65-110`, where gating is `telemetry?.isEnabled !== false`, i.e. opt-out).

## recordSpan [v6 == v7]

`ai/packages/otel/src/record-span.ts:8-50` (== `[v6] src/telemetry/record-span.ts`):

```ts
export async function recordSpan<T>({ name, tracer, attributes, fn, endWhenDone = true }) {
  return tracer.startActiveSpan(name, { attributes: await attributes }, async span => {
    const ctx = context.active();
    try {
      const result = await context.with(ctx, () => fn(span));
      if (endWhenDone) { span.end(); }
      return result;
    } catch (error) {
      try { recordErrorOnSpan(span, error); } finally { span.end(); }
      throw error;
    }
  });
}
```

Errors → `span.recordException({name,message,stack})` + `SpanStatusCode.ERROR` (`record-span.ts:60-74`).

## assembleOperationName [v6 == v7]

`ai/packages/otel/src/assemble-operation-name.ts:3-21`:

```ts
return {
  'operation.name': `${operationId}${telemetry?.functionId != null ? ` ${telemetry.functionId}` : ''}`,
  'resource.name': telemetry?.functionId,
  'ai.operationId': operationId,
  'ai.telemetry.functionId': telemetry?.functionId,
};
```

With ai-chatbot's `functionId: "stream-text"`: root span gets `operation.name = "ai.streamText stream-text"`, `resource.name = "stream-text"`.

## getBaseTelemetryAttributes [v6]

`[v6] src/telemetry/get-base-telemetry-attributes.ts:16-52`: sets `ai.model.provider`, `ai.model.id`, `ai.settings.<key>` for every call setting (maxOutputTokens, temperature, topP, topK, presencePenalty, frequencyPenalty, stopSequences, seed, maxRetries, timeout-as-total-ms), **`ai.telemetry.metadata.<key>` for every entry of `experimental_telemetry.metadata`** (lines 36-43), and `ai.request.headers.<header>` (lines 45-51). The v7 equivalent (`ai/packages/otel/src/get-base-telemetry-attributes.ts:16-37`) **drops metadata** (replaced by `ai.settings.context.*` via `getRuntimeContextAttributes`, `supplemental-attributes.ts`); `ai.telemetry.metadata.*` does not exist anywhere in the v7 repo.

## Span emission in streamText/generateText [v6 — authoritative for ai-chatbot]

### `ai.streamText` (root span)
- Started: `[v6] src/generate-text/stream-text.ts:1276-1290` — `recordSpan({ name: 'ai.streamText', ..., endWhenDone: false })`; tracer from `getTracer(telemetry)` at line 1257.
- Start attributes (1278-1288): operation-name group, base attrs, `'ai.prompt': { input: () => JSON.stringify({ system, prompt, messages }) }`.
- Finish attributes (`stream-text.ts:1143-1169`): `ai.response.finishReason`, `ai.response.text`, `ai.response.reasoning`, `ai.response.toolCalls` (stringified), `ai.response.providerMetadata`, `ai.usage.inputTokens`, `ai.usage.outputTokens`, `ai.usage.totalTokens`, `ai.usage.reasoningTokens`, `ai.usage.cachedInputTokens`. Ended at line 1173.

### `ai.streamText.doStream` (one per step)
- Started: `stream-text.ts:1623-1666` — `recordSpan({ name: 'ai.streamText.doStream', ..., endWhenDone: false })`, wrapped in `retry(...)`.
- Start attributes (1625-1664): operation-name group, base attrs, per-step `ai.model.provider`/`ai.model.id`, `ai.prompt.messages` (`stringifyForTelemetry(promptMessages)`), `ai.prompt.tools` (array of stringified tool defs), `ai.prompt.toolChoice`, **and the gen_ai semconv request attrs**: `gen_ai.system` (= provider), `gen_ai.request.model`, `gen_ai.request.frequency_penalty`, `gen_ai.request.max_tokens`, `gen_ai.request.presence_penalty`, `gen_ai.request.stop_sequences`, `gen_ai.request.temperature`, `gen_ai.request.top_k`, `gen_ai.request.top_p` (lines 1651-1662).
- Stream events: `addEvent('ai.stream.firstChunk', { 'ai.response.msToFirstChunk' })` + same attr on span (1758-1763); `addEvent('ai.stream.finish')` and `ai.response.msToFinish`, `ai.response.avgOutputTokensPerSecond` (1855-1858).
- Finish attributes (1952-1998): `ai.response.finishReason/text/reasoning/toolCalls/id/model/timestamp/providerMetadata`, `ai.usage.inputTokens/outputTokens/totalTokens/reasoningTokens/cachedInputTokens`, and gen_ai response attrs: `gen_ai.response.finish_reasons` (array), `gen_ai.response.id`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`. Ended at line 2006.

### `ai.toolCall`
- Started: `[v6] src/generate-text/execute-tool-call.ts:79-95` — `recordSpan({ name: 'ai.toolCall', ... })` with `ai.operationId='ai.toolCall'`, `operation.name='ai.toolCall'` (+functionId), `ai.toolCall.name`, `ai.toolCall.id`, `ai.toolCall.args: { output: () => JSON.stringify(input) }`; on success sets `ai.toolCall.result` (output-gated). Invoked from streaming via `[v6] src/generate-text/run-tools-transformation.ts:336-343` (passes tracer; deliberately not awaited, comment at line 333).

### generateText / objects / embed / rerank [v6 span names]
- `ai.generateText` root: `[v6] src/generate-text/generate-text.ts:528,533`; `ai.generateText.doGenerate`: `generate-text.ts:767,772`. Note: generateText's doGenerate finish also sets **deprecated-style** `ai.usage.promptTokens` / `ai.usage.completionTokens` (`generate-text.ts:859-860`, root at `1138-1140`) alongside `gen_ai.usage.*` — streamText does NOT set those in v6.
- `ai.generateObject`/`.doGenerate`: `[v6] src/generate-object/generate-object.ts:264,269,311,316` (+ promptTokens/completionTokens at 389-390, 456-457).
- `ai.streamObject`/`.doStream`: `[v6] src/generate-object/stream-object.ts:460,465,535,540`.
- `ai.embed`/`.doEmbed`: `[v6] src/embed/embed.ts:104,119`; `ai.embedMany`: `embed-many.ts:120,146,255`; `ai.rerank`: `rerank.ts:124,140`.

## v7 repo equivalents (for completeness)

- Event emission in v7 `streamText`: dispatcher built at `ai/packages/ai/src/generate-text/stream-text.ts:1002-1010`; `onStart` with `operationId: 'ai.streamText'` published at `stream-text.ts:1484-1514`; `onStepStart` 1822-1846; tool start/end 1881-1888; `onStepEnd` 1243; `onEnd` 1359; `onAbort` 1391; `onError` 2230. `generateText`: `ai/packages/ai/src/generate-text/generate-text.ts:556, 582, 820, 1238, 1325, 1349`.
- `LegacyOpenTelemetry` (v6-compatible spans) — `ai/packages/otel/src/legacy-open-telemetry.ts`: tracer `trace.getTracer('ai')` default (line 149); root span in `onGenerateStart` (line 278) with `ai.prompt` (261-276); step span name `'ai.streamText.doStream'` vs `'ai.generateText.doGenerate'` (536-539), started 587-592 as child of `rootContext`, with `gen_ai.system`, `gen_ai.request.*` (566-584); `ai.toolCall` span 614-618 **as child of `state.stepContext`** with name/id/args (602-612), result 640-646; step finish attrs incl. `gen_ai.response.*`, `gen_ai.usage.input_tokens/output_tokens` and new `ai.usage.inputTokenDetails.*`/`outputTokenDetails.*` (665-744); `ai.stream.firstChunk`/`ai.stream.finish` events (746-758); root finish (810-871).
- New GenAI-semconv `OpenTelemetry` integration emits differently named spans: root `invoke_agent {modelId}`, step `chat {modelId}`, tool `execute_tool {toolName}` with `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.input.messages`, `gen_ai.output.messages`, etc. — `ai/packages/otel/src/open-telemetry.ts:252-296,432-496`; documented in `ai/content/docs/03-ai-sdk-core/60-telemetry.mdx:388-527`.
- Doc section "Legacy AI SDK Spans" (`60-telemetry.mdx:615-805`) documents every legacy span/attribute; its lines 755-756 still list `ai.usage.completionTokens`/`promptTokens` for streamText — stale; v6 streamText emits `ai.usage.inputTokens`/`outputTokens` (code cited above).

# 1C.3 — Span tree for one chat turn with a tool call (streamText, telemetry enabled, ai@6.0.116)

Scenario: "What's the weather in SF?" → model calls `getWeather` → final text step (`stopWhen: stepCountIs(5)`, `route.ts:198`).

```
ai.streamText                                   ← recordSpan, [v6] stream-text.ts:1276-1290 (endWhenDone:false; ended :1173)
│  operation.name="ai.streamText stream-text", resource.name="stream-text",
│  ai.operationId="ai.streamText", ai.telemetry.functionId="stream-text",
│  ai.model.provider, ai.model.id, ai.settings.* (maxRetries, ...),
│  ai.telemetry.metadata.* (none in ai-chatbot), ai.request.headers.*,
│  ai.prompt = JSON {system, prompt, messages}
│  (on finish) ai.response.finishReason/text/reasoning/toolCalls/providerMetadata,
│  ai.usage.inputTokens/outputTokens/totalTokens/reasoningTokens/cachedInputTokens   [stream-text.ts:1143-1169]
│
├── ai.streamText.doStream            (step 1)  ← [v6] stream-text.ts:1623-1666 (ended :2006)
│   │  operation.name="ai.streamText.doStream stream-text", ai.operationId="ai.streamText.doStream",
│   │  base attrs again + ai.prompt.messages, ai.prompt.tools (5 tool defs), ai.prompt.toolChoice,
│   │  gen_ai.system, gen_ai.request.model, gen_ai.request.{frequency_penalty,max_tokens,presence_penalty,
│   │  stop_sequences,temperature,top_k,top_p}                                       [1651-1662]
│   │  events: ai.stream.firstChunk {ai.response.msToFirstChunk} [1758-1763]; ai.stream.finish [1855-1858]
│   │  (on finish) ai.response.finishReason="tool-calls", ai.response.toolCalls=[{getWeather,...}],
│   │  ai.response.id/model/timestamp, ai.usage.*, gen_ai.response.finish_reasons=["tool-calls"],
│   │  gen_ai.response.id/model, gen_ai.usage.input_tokens/output_tokens             [1952-1998]
│   │
│   └── ai.toolCall                             ← [v6] execute-tool-call.ts:79-95, launched (unawaited)
│          operation.name="ai.toolCall stream-text", ai.operationId="ai.toolCall",     from run-tools-transformation.ts:333-343
│          ai.toolCall.name="getWeather", ai.toolCall.id=<callId>,
│          ai.toolCall.args=JSON(input), (on success) ai.toolCall.result=JSON(output)
│
└── ai.streamText.doStream            (step 2 — continuation after tool result)
       same shape as step 1; ai.prompt.messages now includes the assistant tool-call
       and tool-result messages; finish_reasons=["stop"], ai.response.text = final answer.
```

- Multi-step: every step re-enters the same `recordSpan({name:'ai.streamText.doStream'})` block, so N steps ⇒ N sibling `doStream` spans under the single `ai.streamText` root. Documented hierarchy: `ai/content/docs/03-ai-sdk-core/60-telemetry.mdx:652-687`. In v7's `LegacyOpenTelemetry` parenting is explicit: step span child of `rootContext` (`legacy-open-telemetry.ts:587-592`), tool span child of `stepContext` (614-618).
- ai-chatbot nuance: tools `createDocument`/`updateDocument`/`requestSuggestions` make **nested** `streamText` calls (currently untraced). If enabled, each adds a nested `ai.streamText` subtree under the corresponding `ai.toolCall`. Title `generateText` (`actions.ts:28`) is fire-and-forget → separate `ai.generateText` root trace.

# 1C.4 — instrumentation.ts / @vercel/otel, OTLP env vars, shipped tools

## Already present — no new file needed

- `ai-chatbot/instrumentation.ts` **already exists** (root):

```ts
import { registerOTel } from "@vercel/otel";

export function register() {
  registerOTel({ serviceName: "chatbot" });
}
```

(`ai-chatbot/instrumentation.ts:1-5`). `ai-chatbot/instrumentation-client.ts` is unrelated (botid client init).
- Deps already present: `@vercel/otel ^1.12.0` (`package.json:23`), `@opentelemetry/api ^1.9.0`, `@opentelemetry/api-logs ^0.200.0`.
- `ai-chatbot/next.config.ts`: **no** `experimental.instrumentationHook` and none needed — Next.js `16.2.0`; `instrumentation.ts` stable since Next 15.

## Pointing the exporter at a custom OTLP endpoint via env vars

Verified against `vercel/otel` source (`packages/otel/src/sdk.ts`, via gh api):

- Env vars read (sdk.ts `Env` type, lines 62-72): `OTEL_SDK_DISABLED`, `OTEL_SERVICE_NAME`, `OTEL_PROPAGATORS`, `OTEL_TRACES_SAMPLER(_ARG)`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, **`OTEL_EXPORTER_OTLP_ENDPOINT`**, **`OTEL_EXPORTER_OTLP_HEADERS`**, `OTEL_EXPORTER_OTLP_TRACES_HEADERS`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL`, **`OTEL_EXPORTER_OTLP_PROTOCOL`**.
- Default `"auto"` span processor: always adds `BatchSpanProcessor(new VercelRuntimeSpanExporter())`, plus — when `traceExporter` unset/`"auto"` or OTLP env vars exist — `BatchSpanProcessor(parseTraceExporter(env))`.
- `parseTraceExporter(env)`: protocol = `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf"`; headers `key=value,key2=value2`; `"http/json"` → `OTLPHttpJsonTraceExporter`, `"http/protobuf"` → `OTLPHttpProtoTraceExporter`; **grpc unsupported** (warns, falls back to protobuf).
- URL (`buildExporterUrlFromEnv`, sdk.ts:524-536): `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` verbatim; else `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`; else default `http://localhost:4318/v1/traces` (sdk.ts:521-522).

So for a custom collector, **no code change** — just env vars:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # → POSTs to /v1/traces
OTEL_EXPORTER_OTLP_PROTOCOL=http/json               # or http/protobuf (default)
OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer xyz"
```

plus flipping `isEnabled` (1C.1). `OTEL_SERVICE_NAME` env overrides `serviceName` (sdk.ts:117-118). Caveat (Vercel docs): custom spans from Edge-runtime functions not supported.

## Tools shipped by ai-chatbot (5 tools, wired at `route.ts:217-235`, active-tool list `route.ts:202-208`)

| Tool | Definition | Description (verbatim) | Trigger message |
|---|---|---|---|
| `getWeather` | `ai-chatbot/lib/ai/tools/get-weather.ts:32` | "Get the current weather at a location. You can provide either coordinates or a city name." | "What's the weather in San Francisco?" |
| `createDocument` | `ai-chatbot/lib/ai/tools/create-document.ts:22` | "Create an artifact. You MUST specify kind: use 'code' for any programming/algorithm request…" | "Write an essay about Silicon Valley" |
| `editDocument` | `ai-chatbot/lib/ai/tools/edit-document.ts:13` | "Make a targeted edit to an existing artifact by finding and replacing an exact string…" | After creating an artifact: "Change the title from X to Y" |
| `updateDocument` | `ai-chatbot/lib/ai/tools/update-document.ts:19` | "Full rewrite of an existing artifact. Only use for major changes…" | "Rewrite the whole essay to be about Mars" |
| `requestSuggestions` | `ai-chatbot/lib/ai/tools/request-suggestions.ts:21` | "Request writing suggestions for an existing document artifact…" | "Please give me suggestions to improve this document" |

Notes: `createDocument`/`updateDocument` dispatch into `artifacts/{text,code,sheet}/server.ts` (nested streamText calls); `requestSuggestions` runs its own nested `streamText` with `Output.array` (`request-suggestions.ts:49-63`). When a reasoning-capable model without tool support is selected, `experimental_activeTools` is `[]` (`route.ts:199-201`) — no tools fire. All tool definitions live in `ai-chatbot/lib/ai/tools/`.
