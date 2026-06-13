# 1C — Span-to-diagram mapping (against our own fixtures)

Date: 2026-06-12. Inputs:

- `research/fixtures/test-a-reference.json` — Test A-lite trace: native AI SDK v6 telemetry (`ai@6.0.203`), one `streamText` weather turn with a tool call against the deterministic Anthropic mock. 4 spans, 1 trace.
- `research/fixtures/test-b-reference.json` — exported today by `scripts/test-b/export-fixture.ts` (new): zero-telemetry bare app (`test-apps/bare/server.ts`) under the `@agentgraph/register` preload (tier-1 fetch hook), node runtime. 2 traces (one per endpoint `/chat`, `/chat-stream`), **one span each**.
- Schema context: `research/DESIGN.md` §2 (span schema, `agentgraph.*` namespace, query contract §2.3).

## 1. Participant derivation rule

A **participant** (lifeline column) is derived per span, in priority order:

1. **Agent**: `agentgraph.agent.id` when present (DESIGN §2.2 — stamped on every span via the onStart processor when configured).
2. else **fingerprint cluster**: `agentgraph.agent.fingerprint` when present (groups unconfigured agents by stable hash of provider+model+tools+system prefix, DESIGN §2.2/Q6).
3. else **service**: the OTel resource `service.name` (Jaeger `processes[pid].serviceName`).

…except for two span classes that always get their own participant type regardless of the above:

- **Model**: any span passing the DESIGN §2.3 LLM-call contract (`gen_ai.request.model` present AND usage tokens present). Participant key = `provider(span) + ":" + gen_ai.request.model` where `provider := gen_ai.provider.name ?? gen_ai.system` (the §2.3 contract). For AI SDK v6 native spans, fall back to `ai.model.provider`/`ai.model.id` (same values, fixture A `ai.streamText.doStream` tags).
- **Tool**: AI SDK `ai.toolCall` spans → participant key = `ai.toolCall.name`; for our shim / OpenLLMetry-style spans, `gen_ai.tool.name` / operation `execute_tool` (AI SDK v7 names, FINDINGS finding 3).

Rationale for fingerprint **before** service name: one service hosts many logical agents (the whole point of the fingerprint invention, DESIGN Q6); service name is the coarsest bucket, so it is the last resort, not the middle one. **Deviation from the task brief** (which proposed agent.id → service → fingerprint): keeping service above fingerprint would make every unconfigured multi-agent service collapse into one lifeline and the fingerprint would never be used. Flagged for review.

A span class we must anticipate but which neither fixture contains: **inbound channel** (HTTP server span / `agentgraph.channel.type`) — would become the leftmost "caller" participant. See §5 (gaps).

### Applied to fixture A (by hand)

Spans and their participant resolution:

| span | operationName | resolves via | participant |
|---|---|---|---|
| `12b794a2e9552885` (root) | `ai.streamText` | no agent.id/fingerprint → service | `ta-mqbcptif-1zdf` (runtime) |
| `bbc3df22fb8b7e06` | `ai.streamText.doStream` | LLM contract (`gen_ai.request.model`+usage present) | model `anthropic.messages:claude-mock-model` |
| `968eba2eb0343703` | `ai.streamText.doStream` | LLM contract | model `anthropic.messages:claude-mock-model` (same) |
| `26876c60a74cf210` | `ai.toolCall` | tool rule (`ai.toolCall.name`) | tool `getWeather` |

**Columns (3):** `ta-mqbcptif-1zdf` │ `claude-mock-model` │ `getWeather`.

Note the AI SDK v6 wrinkle: the **root** `ai.streamText` span also carries `ai.model.id` but does NOT pass the §2.3 LLM contract (it has `ai.usage.*` but no `gen_ai.usage.*`; only the `doStream` spans carry `gen_ai.*`). If we instead keyed "model participant" on `ai.model.id` presence, the root span would wrongly become a model column. The §2.3 contract (gen_ai keys) classifies correctly here — one more reason it is the right boundary.

### Applied to fixture B (by hand)

| trace | span | resolves via | participant |
|---|---|---|---|
| `/chat` | `chat claude-mock-model` (root, CLIENT) | LLM contract | model `anthropic:claude-mock-model` |
| `/chat-stream` | `chat claude-mock-model` (root, CLIENT) | LLM contract | model `anthropic:claude-mock-model` |

The span carries `agentgraph.agent.fingerprint=6f7dec59198ff155` — but it is an *LLM* span, so the fingerprint identifies which agent **sent** the message, not a second column. The sender participant is derived from the fingerprint: cluster `6f7dec59198ff155` (no `agentgraph.agent.id` on the preload leg; the one-line leg would yield `test-agent` instead, `scripts/test-b/run.ts:183`).

**Columns (2):** agent cluster `6f7dec59198ff155` (label: service name `tb-fixture-*` as display fallback) │ `claude-mock-model`.

This exposes the general rule: **for an LLM/tool span, the source participant is derived from the span's own agent-identity attributes (agent.id/fingerprint/service), and the target participant from its model/tool identity.** The parent span is only the fallback source when the span has no agent-identity attributes (true for fixture A's native spans, which have no `agentgraph.*`).

## 2. Message derivation rule

For each span S with participant P(S) and parent span parent(S) with participant P(parent):

- **Request arrow (solid, filled head)**: when P(S) ≠ P(parent-or-self-derived source) — drawn source → P(S) at `S.startTime`. Label: condensed operation (`doStream` → `chat claude-mock-model`, `ai.toolCall` → `getWeather(args)`).
- **Return arrow (dashed, open head)**: P(S) → source at `S.startTime + S.duration`. Label: outcome summary (finish reason, usage, tool result).
- **Same-participant child** (P(S) == P(parent)): no arrows; renders as an **activation** segment (and optionally a note) on the shared lifeline.
- **Root span**: opens an activation on its participant's lifeline; no arrow (no caller participant exists in either fixture — see §5).

Global ordering: all arrows/events sorted by timestamp (span starts, span ends, span events interleaved). This matters in fixture A: the tool call *starts and ends before the model's first doStream span ends* — see below.

### Hand-derived message list, fixture A (trace `14367ddf86ed1cf769c8d9f6433d0d58`)

Trace t0 = 1781294439547000 µs. R = runtime `ta-mqbcptif-1zdf`, M = `claude-mock-model`, T = `getWeather`. Derived end = startTime + duration.

| # | t (ms) | kind | from → to | source datum |
|---|---|---|---|---|
| 1 | 0.0 | activate R (+ note "ai.streamText test-a-weather") | — | root span start |
| 2 | +12.0 | **solid** R → M, "chat (round 1)" ; activate M | doStream#1 start (1781294439559000) |
| 3 | +116.1 | event marker on M: `ai.stream.firstChunk` | doStream#1 log 1781294439663084 |
| 4 | +121.0 | **solid** R → T, `getWeather({"city":"San Francisco"})` ; activate T | toolCall start 1781294439668000 |
| 5 | +121.7 | **dashed** T → R, `{"temperature":17,"unit":"celsius"}` ; deactivate T | toolCall end 1781294439668742 |
| 6 | +152.7 | event marker on M: `ai.stream.finish` | doStream#1 log 1781294439699714 |
| 7 | +159.5 | **dashed** M → R, `finish=tool-calls · 17 in / 42 out` ; deactivate M | doStream#1 end 1781294439706544 |
| 8 | +163.0 | **solid** R → M, "chat (round 2)" ; activate M | doStream#2 start 1781294439710000 |
| 9 | +172.2 | event marker on M: `ai.stream.firstChunk` | doStream#2 log 1781294439719247 |
| 10 | +216.4 | event marker on M: `ai.stream.finish` | doStream#2 log 1781294439763402 |
| 11 | +217.0 | **dashed** M → R, `finish=stop · 17 in / 42 out · "Hello from the deterministic mock."` ; deactivate M | doStream#2 end 1781294439763987 |
| 12 | +218.9 | deactivate R | root span end 1781294439765936 |

Two load-bearing observations:

1. **Interleaving is real, not theoretical.** The tool request/return (#4/#5) land *inside* the model's round-1 activation (#2–#7): the AI SDK executes the tool as soon as the tool-call block streams in, before `doStream` closes. A renderer that assumes strict call/return nesting (stack discipline) breaks on the very first fixture. Timestamp-sorted emission with per-participant activation counters handles it.
2. **Return arrows carry the payload.** Finish reason, token usage, and (content-gated) response text all live on the span, which ends at return time — the detail panel for a dashed arrow is the span itself (click-to-span, Test F).

**Fragments for fixture A:** the two `doStream` spans are same-operation, same-parent siblings → a `loop [streamText rounds ×2]` fragment spanning #2–#11. Streaming itself can only be bracketed coarsely: a per-round `streaming` fragment from `ai.stream.firstChunk` to `ai.stream.finish` (#3–#6 and #9–#10) — there are **no per-chunk events** in the fixture, so a chunk-loop like the reference screenshot cannot be derived (§5 gap 2).

### Hand-derived message list, fixture B

`/chat` trace (t0 = 1781299782924000): A = agent cluster `6f7dec59198ff155`, M = `claude-mock-model`.

| # | t (ms) | kind | from → to | source datum |
|---|---|---|---|---|
| 1 | 0.0 | **solid** A → M, `chat claude-mock-model` ("Say hello.") ; activate M | span start |
| 2 | +32.9 | **dashed** M → A, `end_turn · 17 in / 42 out · "Hello from the deterministic mock."` | span end (dur 32937µs) |

`/chat-stream` trace: identical shape (+62.2 ms duration). **Nothing in the span distinguishes the streaming endpoint from the non-streaming one** — no events, no `ai.stream.*` analog (§5 gap 3). The diagram for the bare app is honest but minimal: two columns, one request/return pair per turn, no fragments, no notes.

## 3. Fragments and notes — mapping decisions

- **`loop` fragment** ⇐ runs of ≥2 sibling spans with the same operation identity under one parent (fixture A: repeated `doStream` under `streamText` = tool-use rounds). This is derivable today from both AI SDK telemetry and (once a parent exists) our shim.
- **`streaming` fragment (degraded)** ⇐ span-event pair `*.firstChunk` → `*.finish` on an LLM span. Derivable from AI SDK v6 native spans only. Renders as a thin fragment or a shaded band on the model activation; NOT a per-chunk loop.
- **Notes** (the gray step boxes like "1. Resolve agents" in the reference screenshot) ⇐ span events on same-participant/internal spans, or same-participant child spans (rule §2 case 3). **Neither fixture contains such spans/events.** Producing the numbered internal-step notes requires the application (or our SDK's `withAgent()`/a future `step()` API) to emit internal spans or span events — fed back as telemetry requirement R4 below.
- **`alt`/`opt`** ⇐ no span-level analog exists (spans record what happened, not branches not taken). Out of scope; only `loop` + `streaming` fragments are derivable.

## 4. Aggregate (topology) view mapping

Where the sequence view is per-conversation/per-trace, the topology view aggregates over a time window:

- **Node** per participant (same derivation as §1), typed: agent (agent.id), agent-cluster (fingerprint), service (fallback), model, tool, channel (future).
- **Edge** source → target per distinct (source participant, target participant) pair over the window's request arrows; **weight = message count**, annotated with token sums (`gen_ai.usage.*`) and latency percentiles (span durations).
- Fixture A yields: `ta-mqbcptif-1zdf → claude-mock-model` (weight 2, 34 in / 84 out tokens), `ta-mqbcptif-1zdf → getWeather` (weight 1). Fixture B yields: `6f7dec59198ff155 → claude-mock-model` (weight 2 across the two traces).
- This is a small node-link DAG with sized/weighted edges — exactly the shape Codag's ELK + D3 pipeline renders (see graph-1A report); the layout layer is reused directly, only the data model underneath is swapped.

## 5. Gaps pushed back onto the telemetry layer (requirements)

| # | Gap (evidence) | Requirement |
|---|---|---|
| R1 | No caller/channel participant: fixture A's root is the bare `ai.streamText` (no HTTP parent); fixture B's root is the LLM CLIENT span itself. The reference diagram's leftmost "user/channel" lifeline cannot be derived. | Emit an inbound span (HTTP server instrumentation) or stamp `agentgraph.channel.type` (DESIGN §2.2) so the sequence view gets a caller column. Until then the agent lifeline is leftmost. |
| R2 | No per-chunk streaming events anywhere; AI SDK gives only `ai.stream.firstChunk`/`ai.stream.finish` (fixture A doStream logs). | If the chunk-loop visual is wanted, the shim must emit periodic stream-progress span events (e.g. every N chunks: `gen_ai.stream.chunk` with cumulative count). Otherwise accept the degraded firstChunk→finish band. |
| R3 | Our shim emits **no** stream events at all — fixture B's `/chat-stream` span is indistinguishable from `/chat`. | Tier-1 hook should add `firstChunk`/`finish` span events (it already parses SSE for usage parity, so the hook points exist — `packages/core`). |
| R4 | No internal-step spans/events → no numbered notes ("1. Resolve agents" style). | SDK needs a lightweight `step(name)`/event API (or `withAgent` auto-events) before notes can render; treat notes as schema-driven, not heuristic. |
| R5 | Fixture B preload leg has no `agentgraph.agent.id` → lifeline labeled by fingerprint hash, which is user-hostile. | Display contract: fingerprint participants get label = service name + short hash, and upgrade in place when a later span supplies `agent.id` for the same fingerprint (DESIGN Q6 clustering). |

## 6. Fixture provenance note

`test-b-reference.json` was exported today via the new `scripts/test-b/export-fixture.ts` (reuses the Test B harness modules: `startMockAnthropic`, `runLeg`, `fetchTraceJson`). Re-export any time with `node scripts/test-b/export-fixture.ts` (needs `npm run build` + `npm run jaeger:up`). The Test A fixture remains the A-lite export (provenance block inside the file): re-export from the real ai-chatbot app when gateway credentials land.
