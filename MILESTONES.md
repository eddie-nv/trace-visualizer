# AgentGraph — Milestone Plan

Executes `research/DESIGN.md`. Each milestone follows the same git flow:

```
git checkout -b <branch>  →  execute (TDD)  →  commit checkpoints  →  push -u  →  /pr
```

TDD checkpoint commits per `.claude/skills/tdd-workflow` apply inside every milestone:
`test: add reproducer for <x>` (RED) → `fix|feat: <x>` (GREEN) → `refactor: clean up after <x>` (optional).
Every milestone ends with `/code-review` + `/test-coverage` (80% gate) before `/pr`.

**Always-on configs** (every milestone): `rules/common/*`, `rules/typescript/*`, skills `coding-standards` + `tdd-workflow`, agents `tdd-guide` (write tests first) and `code-reviewer` + `typescript-reviewer` (pre-PR review), command `/build-fix` on any build break.
The per-milestone tables below list only what's *additional* and why.

**Milestone ordering constraint** (DESIGN §3/Q2): Test B verification (M5) runs *before* tier-2 fallback work (M6) — tier 2 is built only if/where tier 1 proves insufficient.

---

## M0 — Monorepo scaffolding + test infra

**Branch:** `feat/m0-scaffolding`

**Scope:**
- Workspace monorepo: `packages/core`, `packages/sdk`, `packages/register` (dependency direction `register → sdk → core`, DESIGN §1), strict TS config, vitest, lint/format.
- `docker-compose.yml`: Jaeger all-in-one — OTLP HTTP `4318`, UI `16686` (DESIGN §6 shared infra).
- CI: typecheck + test + coverage on push.
- Smoke test: a span exported from a scratch script is visible via Jaeger `GET /api/traces`.

**Configs to run:**

| Config | Why |
|---|---|
| agent `code-architect` | validate package layout / dependency direction before scaffolding |
| skill `docker-patterns` | Jaeger compose file |
| skill `bun-runtime` | workspace + test tooling must run under both Node and Bun from day one (Q1) |
| command `/plan` | confirm scaffold plan before touching disk |

**Exit criteria:** `npm test`/`bun test` green in all three (empty) packages; Jaeger reachable; CI green.

---

## M1 — `@agentgraph/core`: span schema, content gating, manual API

**Branch:** `feat/m1-core-schema`

**Scope (DESIGN §1 core, §2, §4):**
- `ATTR` constants — GenAI semconv ≥1.40 set, no `total_tokens` (§2.1).
- `shouldSendContent()` — single gate in core; resolution order context-key → config → default true; drops exactly the four content attrs (§4, fixes both OpenLLMetry bugs).
- `withLLMCall` / `LLMSpan` manual API — semconv-1.40 JSON message attrs, respects content gating (§1).
- `agentgraph.agent.fingerprint` hash function (Q4 — implement proposed definition, mark provisional).
- Emits via global `trace.getTracer("agentgraph")` — no provider setup in core.

**Configs to run:**

| Config | Why |
|---|---|
| agent `type-design-analyzer` | first of the three public API surfaces (`CoreConfig`, `LLMSpan`, `ATTR`) — invariants must be right before dependents exist |
| skill `error-handling` | typed error patterns for the manual API boundary |
| command `/quality-gate` | per-file gate on the new modules |

**Exit criteria:** unit tests cover schema emission, gating on/off/context-override, manual API happy + error paths; coverage ≥80%.

---

## M2 — `@agentgraph/core`: tier-1 fetch hook

**Branch:** `feat/m2-fetch-hook`

**Scope (DESIGN §3 tier 1):**
- `instrumentFetch()`/`uninstrumentFetch()` — idempotent patch of `globalThis.fetch`; match `api.anthropic.com` `POST /v1/messages` + `api.openai.com` `POST /v1/chat/completions`; pass-through otherwise.
- Span lifecycle: start from parsed request body, end on response completion.
- Streaming: `ReadableStream.tee()`, SSE parse on our branch, usage accumulation from `message_start`/`message_delta` (Anthropic); OpenAI streams without `include_usage` → span without usage (Q3 deferred).
- Stream error: ERROR status + `recordException` + end + rethrow.
- `SUPPRESS_FETCH_SPAN_KEY` context check (§3.4).
- Displaced-fetch detection (`fetch !== ourWrapper` warn-once).

**Configs to run:**

| Config | Why |
|---|---|
| agent `silent-failure-hunter` | the shim must never crash or alter the host app — but also must not *silently* drop spans; audit every catch |
| agent `performance-optimizer` | this wrapper is on the hot path of every fetch in the host app |
| agent `security-reviewer` | we tee and parse request/response bodies containing user prompts — content handling + gating is security-sensitive |
| skill `error-handling` | catch-and-degrade policy at every hook boundary |

**Exit criteria:** unit tests with mocked fetch/SSE fixtures: non-streaming, streaming usage accumulation, non-matching passthrough untouched, suppress-key respected, error paths rethrow byte-identically; coverage ≥80%.

---

## M3 — `@agentgraph/sdk`: init + context API

**Branch:** `feat/m3-sdk-init`

**Scope (DESIGN §1 sdk, §3.5):**
- `init()` with the documented ordering: env defaulting → hook install → exporter (OTLP/HTTP protobuf at `${endpoint}/v1/traces`) → Simple/Batch processor wrapped with `onStart` stamping → `BasicTracerProvider` + ALS context manager registration.
- Env var table (`AGENTGRAPH_ENDPOINT`, `_HEADERS`, `_TRACE_CONTENT`, `_DISABLE_BATCH`, `_AGENT_ID`, `_INSTRUMENT_SDKS`).
- `withAgent`/`withConversation` — context keys + `onStart` processor stamping `agentgraph.*` on every span, global-agentId fallback (§3.5, §2.2).
- `forceFlush()`/`shutdown()`.

**Configs to run:**

| Config | Why |
|---|---|
| agent `type-design-analyzer` | second public surface: `init` options object |
| skill `backend-patterns` | exporter/processor wiring, env-config precedence |
| skill `bun-runtime` | provider setup under Bun is the open Q1 deviation — keep choices Bun-compatible |
| agent `security-reviewer` | header handling (`AGENTGRAPH_HEADERS` may carry auth tokens) — no leakage into spans/logs |

**Exit criteria:** unit + integration tests (in-memory exporter): init ordering, env precedence vs options, stamping on nested spans, flush/shutdown; coverage ≥80%.

---

## M4 — `@agentgraph/register`: preload entries

**Branch:** `feat/m4-register-preload`

**Scope (DESIGN §1 register):**
- ESM entry (`--import` / `bun --preload`) + CJS twin (`--require`), side-effect-only, env-configured `sdk.init()`.
- Idempotency via `globalThis.__AGENTGRAPH__.registered`.
- All failures → single `console.warn`, never crash the host.
- Default tier 1 only; `AGENTGRAPH_INSTRUMENT_SDKS=true` reserved for tier 3 (wired in M6).

**Configs to run:**

| Config | Why |
|---|---|
| agent `silent-failure-hunter` | the entire module is a catch-and-warn boundary — verify warn-once actually fires and failures aren't swallowed invisibly |
| skill `bun-runtime` | `bun --preload` semantics vs `NODE_OPTIONS --import` |
| agent `type-design-analyzer` | third public surface (entry exports/conditions in package.json) |

**Exit criteria:** subprocess tests: double-registration is a no-op, broken env doesn't crash a host script, both ESM and CJS entries load under Node; Bun preload smoke test.

---

## M5 — Test B: bare-app verification (answers Q1/Q2) ← gate for M6

**Branch:** `feat/m5-test-b-verification`

**Scope (DESIGN §6 Test B):**
- Scaffold `test-apps/bare/`: plain Node/TS HTTP server, `@anthropic-ai/sdk` direct, `POST /chat` + `POST /chat-stream`, zero OTel imports; Bun-runnable.
- E2E harness asserting via Jaeger API: the 5 pass criteria — span attrs, streaming==non-streaming usage, content-toggle removal, **byte-identical responses with/without preload**, Bun leg.
- One-line tier: `init({agentId})` → all spans carry `agentgraph.agent.id`.
- Record Q1/Q2 answers in `research/DESIGN.md` open-questions table.

**Configs to run:**

| Config | Why |
|---|---|
| skill `verification-loop` | this milestone *is* the verification loop — structured evidence per pass criterion |
| skill `docker-patterns` | Jaeger compose orchestration in the harness |
| skill `bun-runtime` | the Bun leg is the decisive Q1/Q2 evidence |
| agent `silent-failure-hunter` | byte-identical gate failures often hide in teeing edge cases |
| command `/test-coverage` | E2E counts toward the 80% mix (testing rule requires unit+integration+E2E) |

**Exit criteria:** all 5 Test B criteria green on Node AND Bun; Q1/Q2 answers documented. **Decision point:** Q2 outcome determines M6 scope (if SDKs bypass global fetch, tier 2 is mandatory; otherwise it stays opt-in).

---

## M6 — Tier 2/3: SDK prototype patching + dedup (scope set by M5)

**Branch:** `feat/m6-tier2-sdk-patching`

**Scope (DESIGN §3 tiers 2–3, §3.4):**
- `AnthropicInstrumentation`/`OpenAIInstrumentation` (`InstrumentationBase`), `manuallyInstrument()` escape hatch, stream re-wrap preserving `APIPromise`/`Stream` types.
- `init({instrumentModules})` activation path.
- Tier dedup: tier-2 wrapper runs under `SUPPRESS_FETCH_SPAN_KEY` context.
- Tier 3: module-load hooks behind `AGENTGRAPH_INSTRUMENT_SDKS=true`, Sentry-style try/catch-warn around `module.register()`.

**Configs to run:**

| Config | Why |
|---|---|
| agent `code-architect` | tier-2/3 wiring touches all three packages — blueprint first |
| skill `error-handling` | loader hooks are the documented-fragile layer (F1–F5); every failure mode needs a degrade path |
| agent `silent-failure-hunter` | try/catch-warn around module.register must not mask real init failures |
| command `/test-coverage` | dedup logic needs explicit both-tiers-active tests |

**Exit criteria:** with both tiers active, exactly one span per LLM call; `manuallyInstrument` works without loader hooks; tier 3 only activates via env flag; Test B suite still fully green (regression gate).

---

## M7 — Tests A + C: native-telemetry interop + equivalence contract

**Branch:** `feat/m7-test-a-c-equivalence`

**Scope (DESIGN §2.3, §6 Tests A/C):**
- Test A: run vercel/ai-chatbot with `@vercel/otel` → Jaeger (env-only config, `isEnabled: true` flip), one `getWeather` turn; assert span tree + parenting + timestamps; export `research/fixtures/test-a-reference.json`. *Dependency: Vercel AI Gateway credentials.*
- Test C: query-contract script (`isLLMCall`/`provider`/`usage`, §2.3) run against both Jaeger result sets; zero false positives; single code path (only the documented `gen_ai.provider.name ?? gen_ai.system` coalesce). Commit the script — it becomes the graph layer's ingestion predicate.
- If C fails: fix §2 schema mapping in core, re-run A and B.

**Configs to run:**

| Config | Why |
|---|---|
| skill `verification-loop` | acceptance evidence per criterion, fixtures committed |
| skill `api-design` | the query contract is the ingestion API for the future graph layer — review it as one |
| agent `code-reviewer` | the contract script ships as the executable spec |

**Exit criteria:** Test A trace exported as fixture; Test C selects exactly the LLM spans in both sets via one code path; remaining open questions (Q3–Q7) updated with evidence or explicitly deferred in DESIGN.md.

---

## Summary

| # | Milestone | Branch | Key gate |
|---|---|---|---|
| M0 | Scaffolding + Jaeger | `feat/m0-scaffolding` | CI green, Jaeger reachable |
| M1 | core: schema + gating + manual API | `feat/m1-core-schema` | 80% coverage, gating bug-proof |
| M2 | core: fetch hook | `feat/m2-fetch-hook` | byte-identical passthrough in unit tests |
| M3 | sdk: init + withAgent | `feat/m3-sdk-init` | stamping on every span |
| M4 | register: preload | `feat/m4-register-preload` | never crashes host, idempotent |
| M5 | Test B (Q1/Q2) | `feat/m5-test-b-verification` | all 5 criteria, Node + Bun |
| M6 | tier 2/3 + dedup | `feat/m6-tier2-sdk-patching` | one span per call, Test B regression green |
| M7 | Tests A + C | `feat/m7-test-a-c-equivalence` | contract holds, fixtures committed |

---

## M8 — Telemetry enrichment: R1 HTTP spans · R3 stream events · R6 code locations

**Branch:** `feat/m8-telemetry-enrichment`

**Context:** M1–M7 deliver a complete LLM-call instrumentation layer but the visualizer needs three more data points to render usefully: a root span that positions the diagram's first arrow (R1), timing markers that distinguish a streaming endpoint from a non-streaming one (R3), and a code location on every span so clicking a node navigates to source (R6). These are additive changes — no existing span shape or test contract changes.

**Scope:**

*R1 — HTTP server root span (`packages/register`):*
- Add `@opentelemetry/instrumentation-http` as a dependency of `packages/register`.
- In `register.ts`, call `registerInstrumentations([new HttpInstrumentation()])` before `sdk.init()` so the inbound HTTP span becomes the trace root that parents all downstream LLM spans.
- Outcome: `POST /agent/default/run` appears as the root span; the visualizer's leftmost arrow is derivable from traces.

*R3 — Stream event markers (`packages/core` `fetch-hook.ts` + `sse.ts`):*
- In `finishStreaming` (currently line 315), record `span.addEvent('gen_ai.stream.first_chunk', { timestamp })` on first yield from `parseSseStream` and `span.addEvent('gen_ai.stream.finish', { timestamp })` on generator exhaustion.
- Outcome: `/chat-stream` and `/chat` spans are distinguishable; the visualizer can render the `streaming` fragment band between the two events.

*R6 — Code location stamping (`packages/core` new `caller-frame.ts`, `span-lifecycle.ts`):*
- New `captureCallerFrame()`: split `new Error().stack`, skip frames matching `agentgraph/`, `@opentelemetry/`, `node:`, return the first external frame parsed to `{file, line, fn}`.
- In `startLLMSpan`, stamp OTel semconv `code.file.path`, `code.line.number`, `code.function.name` from the captured frame.
- Accept v1 caveats in a code comment: bundled paths (no source-map resolution yet), and AI SDK native spans carry none of these attributes.
- Outcome: every span our shim emits carries a navigable code location; MCP `get_span` and the detail panel can surface it.

**Files changed:**
- `packages/register/src/register.ts` — add `registerInstrumentations`
- `packages/register/package.json` — add `@opentelemetry/instrumentation-http` dep
- `packages/core/src/caller-frame.ts` — new
- `packages/core/src/span-lifecycle.ts` — stamp `code.*` in `startLLMSpan`
- `packages/core/src/fetch-hook.ts` — `addEvent` calls in `finishStreaming`
- `packages/core/src/span-attrs.ts` — `setCallerAttributes` helper
- `packages/core/src/attributes.ts` — `ATTR.CODE_FILE`, `ATTR.CODE_LINE`, `ATTR.CODE_FUNCTION` constants
- `research/fixtures/test-b-reference.json` — re-export after M8 to capture enriched spans

**Configs to run:**

| Config | Why |
|---|---|
| agent `tdd-guide` | R6 stack parsing has many edge cases (anonymous frames, bundler noise, strict-mode differences) — write failure cases first |
| agent `silent-failure-hunter` | `new Error().stack` is undefined in some runtimes; every R6 path must degrade silently without touching the span's existing attributes |
| agent `performance-optimizer` | `captureCallerFrame` runs on every LLM call; profile that stack splitting stays sub-µs under Bun and Node |
| agent `security-reviewer` | stack frames may expose internal file paths — confirm `code.file.path` contains only project-relative paths, not absolute ones that leak host layout |
| command `/test-coverage` | three separate additions each need their own test file; confirm 80% gate holds per file |

**Exit criteria:**
- `/chat-stream` span in a re-exported Test B fixture has `gen_ai.stream.first_chunk` and `gen_ai.stream.finish` events with timestamps.
- Every LLM span emitted by our shim has non-empty `code.file.path`, `code.line.number`, `code.function.name`.
- A new HTTP root span parents the LLM spans when the bare app is started with the preload under Node.
- Test B suite (`npm run test:b`) remains fully green — no regression.
- `npm run build` and `bun test` green across all packages.

---

## M9 — `packages/extension`: OTLP receiver · span-store · postMessage fanout

**Branch:** `feat/m9-extension-receiver`

**Context:** This milestone creates the new VS Code extension package. It deliberately excludes the visual renderer (M10) and MCP server (M12) to keep the blast radius small — the goal is a provably working data pipeline from app → extension → webview before any rendering is written. Option B (decided): the receiver runs on `:4319`, independent of Jaeger on `:4318`. Users set `AGENTGRAPH_ENDPOINT=http://localhost:4319`; the extension optionally forwards to Jaeger.

**Scope:**

*Extension scaffold (`packages/extension`):*
- `package.json`: VS Code extension manifest (`engines.vscode`, `activationEvents`, `contributes.commands`), `vsce`-compatible build, `esbuild` for both extension host and webview bundles as separate entry points.
- `src/extension.ts`: `activate()` starts the OTLP receiver and registers commands (`agentgraph.open`).

*OTLP receiver (`src/receiver/otlp-receiver.ts`):*
- Minimal HTTP server (Node `http` module, no framework) listening on `:4319` (configurable via `agentgraph.receiverPort` VS Code setting).
- Accepts `POST /v1/traces` with `Content-Type: application/json` (OTLP/HTTP JSON — the format `@opentelemetry/exporter-trace-otlp-http` sends by default).
- Optional forward: if `agentgraph.jaegerEndpoint` is set, fire-and-forget re-POST to Jaeger at `:4318`.
- Parses the OTLP JSON envelope to extract `ResourceSpan → ScopeSpan → Span` arrays with their resource attributes (`service.name` from the resource).

*Span store (`src/receiver/span-store.ts`):*
- In-memory `Map<traceId, TracedConversation>` where `TracedConversation = { traceId, rootSpan?, spans: Span[], serviceSeen: Set<string>, complete: boolean }`.
- `addSpan(resourceSpan, span)`: append, detect root (no parent reference), mark `complete` when root span arrives (root spans export last, after all children).
- `getConversations()`: list all known traces, most recent first, for the sidebar.
- Bounded: keep at most 100 traces (drop oldest); no persistence in v1.

*postMessage fanout (`src/receiver/fanout.ts`):*
- On each `addSpan` call, if a webview panel is open: `panel.webview.postMessage({ command: 'span', traceId, span, serviceName })`.
- On panel open: replay all stored spans for the active trace via `initTrace` command (queue-until-ready pattern from Codag — buffer until `webviewReady` ack).

*Webview shell (`webview-src/app.ts`):*
- Bare HTML + a single `<div id="diagram">` placeholder; wires the `message` listener and echoes `webviewReady` back.
- Renders received spans as a plain `<pre>` dump — visual rendering is M10.

*Source locator (`src/source-locator.ts`):*
- Handles `openFile` messages from the webview: `vscode.workspace.findFiles('**/' + relativePath, '**/node_modules/**', 5)`, open with `showTextDocument` in `ViewColumn.Beside`, `revealRange` centered on the line.
- Falls back to a workspace search by function name if `code.file.path` is missing (uses `ai.telemetry.functionId` for AI SDK native spans).

**Files created:**
```
packages/extension/
  package.json
  tsconfig.json
  esbuild.config.ts
  src/
    extension.ts
    receiver/
      otlp-receiver.ts
      span-store.ts
      fanout.ts
    webview/
      panel.ts
      messages.ts     # postMessage command types (shared between host + webview)
    source-locator.ts
    commands.ts
  webview-src/
    app.ts
    app.html
```

**Configs to run:**

| Config | Why |
|---|---|
| agent `code-architect` | first file in a new package — validate the extension host ↔ webview ↔ receiver dependency graph and build config before writing any code |
| agent `silent-failure-hunter` | the OTLP receiver must never crash VS Code on malformed JSON, port conflicts, or a closed webview panel; every path needs an explicit degrade |
| agent `security-reviewer` | the receiver accepts arbitrary HTTP POST on localhost; validate it binds only to `127.0.0.1`, rejects oversized bodies, and does not expose span content outside the extension sandbox |
| skill `error-handling` | typed error patterns for the receiver HTTP server boundary and the `addSpan` pipeline |
| skill `backend-patterns` | OTLP HTTP receiver design, bounded store eviction policy |
| skill `docker-patterns` | update `docker-compose.yml` to document the `:4319` port convention alongside the existing Jaeger `:4318`/`:16686` entries |
| command `/build-fix` | new package with its own TS config and dual esbuild targets (extension + webview) — build errors are likely on first wire-up |

**Exit criteria:**
- `packages/extension` builds cleanly (`npm run build`); extension host and webview are separate bundles.
- With `AGENTGRAPH_ENDPOINT=http://localhost:4319`, running `npm run test:b` causes spans to appear in a VS Code `OutputChannel` log.
- Clicking `agentgraph.open` command opens a webview panel that logs received span `operationName` values as plain text.
- Clicking a span line in the panel triggers `openFile` and VS Code navigates to the file + line from `code.file.path` / `code.line.number` (requires M8 to be merged first).
- `source-locator.ts` has unit tests covering: file found, file not found (fallback), missing code location (graceful no-op).
- Port conflict (`:4319` already in use) shows a VS Code error notification and does not crash the extension.

---

## M10 — Webview renderer: swimlane layout · columns · arrows · action nodes · detail panel

**Branch:** `feat/m10-renderer`

**Context:** The render layer. Works entirely in the webview bundle (`webview-src/`) and is pure browser code with no VS Code API calls — making it testable with Vitest + jsdom and portable to a standalone browser if needed later. The layout engine adapts Mermaid's append-only y-cursor and Codag's layered-SVG + D3 scene structure, both fully researched in `research/raw/graph-1A-codag-visualizer.md` and `research/raw/graph-1B-mermaid-sequence.md`.

**Scope:**

*View model + span classifier (`webview-src/store/`):*
- `view-model.ts`: pure TypeScript types — `Participant`, `ActionNode` (same-service child span: column + y-position, code location, span ID), `Arrow` (cross-service: source participant, target participant, solid/dashed, label, span ID), `Fragment` (loop: open y, close y, label).
- `span-classifier.ts`: pure function `spansToViewModel(spans: Span[]): ViewModel` — classifies each span: cross-service → Arrow, same-service child → ActionNode, sibling group ≥2 with same operationName → Fragment. No side effects; the Test D assertion target.
- `trace-store.ts`: receives `postMessage` spans, appends to `spansToViewModel`, notifies renderer on change.

*Layout engine (`webview-src/layout/`):*
- `column-manager.ts`: `Map<participantId, {x, width}>`. Fixed column gap (200px default, configurable). New participants append at `max(existingX) + columnGap`. No label-driven widening — labels wrap to the column width. Running sum x is O(1) per new participant.
- `swimlane.ts`: append-only y-cursor. Per-span band height is fixed (60px for an Arrow, 40px for an ActionNode, 10px gap between). Fragment open/close uses Mermaid's stack model (`sequenceRenderer.ts:170-188` reference): push `{starty, label}` on open, pop and record `stopy` on close. State that persists between appends: cursor, open-fragment stack, column table.

*Renderer (`webview-src/renderer/`):*
- `scene.ts`: one SVG full-viewport → `<defs>` (arrowhead markers solid + dashed) → zoomable root `<g>` → layer groups in z-order: `.fragments` → `.lifelines` → `.arrows` → `.nodes` → `.panel`. d3-zoom `scaleExtent([0.1, 4])`. (Codag `setup.ts:6-130` reference.)
- `columns.ts`: service header boxes (`<rect>` + `<text>`) at top; vertical lifeline `<line>` extending to current diagram bottom, updated on each append. Click on header → `postMessage({command: 'participantSelected', participantId})` → detail panel shows service metadata.
- `arrows.ts`: horizontal `<line>` between lifeline x-positions at the arrow's y-band. Solid = `stroke-dasharray: none`, marker-end filled triangle. Dashed = `stroke-dasharray: 6 3`, marker-end open triangle. Wide invisible `.arrow-hit` path underneath for click targeting (Codag `edges.ts:256-294` reference). Click → `postMessage({command: 'spanSelected', spanId})`.
- `action-nodes.ts`: `<rect>` + `<text>` stacked in the participant's column, centered on the lifeline. Click → `postMessage({command: 'spanSelected', spanId})`.
- `fragments.ts`: open loop box drawn as a provisional dashed `<rect>` growing as ActionNodes accumulate; finalized (solid border + label) when the fragment closes.
- `detail-panel.ts`: static `<div>` overlaid at right. On `spanSelected`: populate with span attributes (operationName, service, duration, tokens, finish reason, `code.*`). "Open in editor" button → `postMessage({command: 'openFile', file, line})`.

*Theming:*
- CSS custom properties: `--tv-bg`, `--tv-surface`, `--tv-border`, `--tv-text`, `--tv-accent`, `--tv-arrow-solid`, `--tv-arrow-dashed`, `--tv-highlight`. Dark defaults matching the reference screenshot. VS Code webview host sets `--vscode-*` vars — a thin mapping layer (`theme.ts`) bridges them: `--tv-bg: var(--vscode-editor-background, #1e1e1e)` etc.

*D3 update tiers (Codag `messages.ts:360-424` reference):*
- Additive (new span below existing): D3 keyed join enter only — existing DOM untouched, new elements appended. This is the common case.
- Complete re-classify (rare, e.g. fragment closed): re-derive view model, keyed join with exit/update/enter, 150ms opacity crossfade.

**Files created:**
```
webview-src/
  store/
    view-model.ts
    span-classifier.ts
    trace-store.ts
  layout/
    column-manager.ts
    swimlane.ts
  renderer/
    scene.ts
    columns.ts
    arrows.ts
    action-nodes.ts
    fragments.ts
    detail-panel.ts
    theme.ts
  app.ts            # updated: wire store → layout → renderer
```

**Configs to run:**

| Config | Why |
|---|---|
| agent `tdd-guide` | `span-classifier.ts` and `swimlane.ts` are pure functions — write Test D assertions (fixture A → expected 12-row message table from `research/raw/graph-1C-span-mapping.md`) before any implementation |
| agent `type-design-analyzer` | `Participant`, `ActionNode`, `Arrow`, `Fragment` are the public view-model boundary consumed by layout, renderer, MCP, and tests — invariants must be right before dependents exist |
| agent `code-architect` | renderer has 6 files with strict z-order and data-flow dependencies; blueprint the SVG layer order and the store → layout → renderer data flow before writing |
| agent `performance-optimizer` | D3 joins on every incoming span during a live stream — profile that keyed enter-only updates don't reflow the entire SVG; measure frame budget under 50 spans/sec |
| agent `typescript-reviewer` | D3 selections are typed as `any` in Codag's approach; lock down the view-model types flowing into D3 `.data()` calls |
| skill `tdd-workflow` | Test D is the primary gate for this milestone — TDD rhythm enforces the classifier is correct before the renderer hides bugs |
| command `/test-coverage` | `span-classifier.ts` and `swimlane.ts` must hit 80%+ with unit tests; renderer files covered by Test D replay |

**Exit criteria (Test D):**
- `spansToViewModel(fixtureASpans)` returns exactly: 3 participants (`ta-mqbcptif-1zdf`, `claude-mock-model`, `getWeather`), 4 arrows (2 solid R→M, 1 solid R→T, 1 dashed T→R), 4 dashed return arrows, 2 span events on M's activation, 1 `loop` fragment wrapping the two doStream rounds — matching the hand-derived table in `research/raw/graph-1C-span-mapping.md §2`.
- The rendered SVG (verified by Playwright screenshot or jsdom snapshot) shows 3 labeled column headers, lifelines, correctly typed arrows, and the loop box.
- Clicking a dashed return arrow populates the detail panel with token counts from the span.
- No layout shift when a second span batch is appended (append-only invariant).
- `npm run build` green; webview bundle < 500KB gzipped.

---

## M11 — Extension wiring: live streaming · loop fragments · trace sidebar

**Branch:** `feat/m11-wiring`

**Context:** Connects M9 (receiver) to M10 (renderer) end-to-end with a real running app. Adds the trace-sidebar navigation, finalizes the postMessage protocol between extension host and webview, and completes loop-fragment detection on the live stream. Gate is Test E: the bare app streaming in real time with the diagram growing top-down and no layout shifts.

**Scope:**

*postMessage protocol completion (`src/webview/messages.ts`):*
- Finalize all command types in both directions:
  - Extension → webview: `initTrace` (full replay on panel open), `appendSpan`, `traceComplete` (root span arrived — draw footer boxes), `themeChange`.
  - Webview → extension: `webviewReady`, `spanSelected`, `participantSelected`, `openFile`.
- Queue-until-ready: buffer `appendSpan` messages until `webviewReady` received, then flush (Codag `webview.ts:41-100` reference).

*Trace sidebar (`src/webview/panel.ts` + `webview-src/sidebar.ts`):*
- VS Code `WebviewView` (sidebar panel) listing all traces in `span-store`: root span `operationName`, timestamp, service count, complete/in-flight indicator.
- Clicking a trace sends `initTrace` to the main diagram panel, which replays all stored spans and renders the full diagram.

*Live streaming wiring:*
- `fanout.ts` updated: on `addSpan`, if active trace = the incoming `traceId`, `appendSpan` is posted immediately. Spans for a non-active trace are stored but not fanned out until the user selects that trace.
- `traceComplete` posted when `span-store` marks the trace complete (root span received).

*Loop fragment real-time detection (`webview-src/store/span-classifier.ts` update):*
- On each `appendSpan`: check if the new span's `operationName` matches any existing sibling under the same parent. If yes, open a fragment if not already open; extend it on each additional match. Fragment closes when the parent span ends (signaled by `traceComplete` or a span whose end time > all children).

*Footer / trace-complete rendering (`webview-src/renderer/columns.ts` update):*
- On `traceComplete`: draw mirrored service header boxes at the bottom of each lifeline (matching the reference image), set lifeline final `y2`, update SVG viewBox.

*Configuration (`package.json` contributes):*
- `agentgraph.receiverPort` (default `4319`)
- `agentgraph.jaegerEndpoint` (optional forward, default empty)
- `agentgraph.columnWidth` (default `200`)

**Files changed:**
```
src/webview/messages.ts       # complete protocol
src/webview/panel.ts          # sidebar + queue-until-ready
src/receiver/fanout.ts        # active-trace filtering
webview-src/sidebar.ts        # new: trace list UI
webview-src/store/
  span-classifier.ts          # live fragment detection
  trace-store.ts              # active trace selection
webview-src/renderer/
  columns.ts                  # footer + viewBox finalization
  scene.ts                    # themeChange handler
```

**Configs to run:**

| Config | Why |
|---|---|
| agent `tdd-guide` | Test E is an E2E harness (like Test B) — write the assertions before wiring the live path |
| agent `silent-failure-hunter` | the live fanout path has three async hops (OTLP → store → postMessage → webview render); audit every failure mode — panel closed mid-stream, span arriving after traceComplete, out-of-order spans |
| skill `verification-loop` | Test E is structured evidence: assert no layout shifts, assert diagram grows top-down, assert footer appears on traceComplete |
| agent `typescript-reviewer` | the postMessage protocol is the internal API between extension host and webview; type it strictly (discriminated union on `command`) |
| command `/test-coverage` | new `sidebar.ts` and the `fragment-detection` path in `span-classifier.ts` need unit coverage before the E2E test counts them |

**Exit criteria (Test E):**
- Start `test-apps/bare/server.ts` with `AGENTGRAPH_ENDPOINT=http://localhost:4319` and the preload.
- Open the `agentgraph.open` panel in VS Code.
- POST to `/chat-stream`.
- The diagram draws top-down as spans arrive: lifelines appear left-to-right in participant order, arrows append below existing ones without any existing node or arrow moving.
- `gen_ai.stream.first_chunk` and `gen_ai.stream.finish` events are visible as event markers on the model activation.
- When the root span arrives, footer boxes appear and the sidebar marks the trace complete.
- No console errors in the webview during the streaming run.

---

## M12 — MCP server + Test F (multi-participant live tool call)

**Branch:** `feat/m12-mcp-test-f`

**Context:** Adds the MCP server that makes trace data available to coding agents (Claude Code, Cursor), and runs Test F — the most demanding integration test: a live tool call mid-conversation that adds a new lifeline dynamically, with click-to-span verified end-to-end.

**Scope:**

*MCP server (`src/mcp/`):*
- Spawned as a `StdioServerTransport` child process by the extension on activate (same pattern as Codag `packages/mcp-server/src/index.ts`).
- Reads from `span-store` via an IPC channel (the child process imports the store module directly — same Node.js process space via `child_process.fork`).
- One auto-injected resource: `agentgraph://traces/summary` — live markdown digest: agent/service count, top operations by call count, last 5 conversation summaries.
- Six tools (Zod-validated inputs):

| Tool | Input | Output |
|---|---|---|
| `get_conversation` | `trace_id: string` | Full sequence: participants, ordered arrows, action nodes, fragments |
| `list_agents` | `limit?: number` | Participants seen, call counts, input/output token totals, last-seen timestamp |
| `get_span` | `span_id: string` | All attributes — operationName, service, duration, tokens, `code.*` (the agent analog of click-to-source) |
| `get_agent_context` | `agent_id: string` | Files and functions touched by spans for this agent (requires R6 code locations) |
| `search_traces` | `query: string, limit?: number` | Traces whose span operationNames or attributes match keywords |
| `list_recent_traces` | `limit?: number` | Most recent traces with root operation, timestamp, service count, status |

*`.mcp.json` scaffold (repo root):*
```json
{
  "mcpServers": {
    "agentgraph": {
      "command": "node",
      "args": ["packages/extension/dist/mcp.js", "--ipc"]
    }
  }
}
```

*Test F harness (`scripts/test-f/run.ts`):*
- Use `workspace/ai-chatbot` (has tool calls mid-conversation — already in the workspace from M7 research).
- Start with `AGENTGRAPH_ENDPOINT=http://localhost:4319`.
- Trigger a tool-call turn (weather query or similar).
- Assert via the webview's postMessage log (captured by a test harness webview) and the MCP `get_conversation` tool:
  - F1: Tool participant (`getWeather` or equivalent) appears as a new column after the first two-column initial render.
  - F2: No existing arrows or nodes moved when the tool column was inserted.
  - F3: Clicking the dashed return arrow from the tool opens the detail panel showing `gen_ai.usage.output_tokens` and (if our shim instrumented the tool call) `code.file.path`.
  - F4: MCP `get_span` for the tool span returns `code.function.name`.
  - F5: MCP `get_agent_context` returns the file that contains the tool implementation.

**Files created:**
```
src/mcp/
  server.ts           # McpServer, StdioServerTransport, tool registration
  tools.ts            # getConversation, listAgents, getSpan, getAgentContext, searchTraces, listRecentTraces
  ipc-store.ts        # read span-store over fork IPC
scripts/test-f/
  run.ts
  criteria.ts
.mcp.json             # repo-root MCP config
```

**Configs to run:**

| Config | Why |
|---|---|
| agent `tdd-guide` | Test F criteria F1–F5 are the test targets — write them as assertions before instrumenting `ai-chatbot` |
| agent `code-architect` | MCP IPC design (fork vs HTTP vs shared module) needs a blueprint before implementation — IPC is non-obvious with VS Code's extension host |
| agent `type-design-analyzer` | MCP tool input/output types are the public API consumed by Claude Code and Cursor; Zod schemas must be exact |
| agent `security-reviewer` | MCP server accepts queries from coding agents that may be running untrusted code; validate that `search_traces` cannot be used to exfiltrate content beyond what the span already recorded |
| skill `api-design` | MCP tool descriptions are the API surface — review for clarity, scope-setting ("only covers observed spans"), and avoiding false completeness claims |
| skill `verification-loop` | Test F produces structured evidence per criterion (F1–F5) matching the M5/M7 pattern |
| command `/test-coverage` | MCP tools.ts is a pure-function layer over span-store — high unit test coverage achievable and required |

**Exit criteria (Test F):**
- All five F1–F5 criteria pass against a live `ai-chatbot` run.
- `.mcp.json` works with `claude --mcp` in the repo root: `get_conversation` returns a readable trace summary.
- MCP `list_agents` shows participants from the Test F run with correct token totals.
- Extension activates, OTLP receiver starts, and MCP server spawns in a single VS Code window open — no manual steps beyond `code .`.

---

## Summary

| # | Milestone | Branch | Key gate |
|---|---|---|---|
| M0 | Scaffolding + Jaeger | `feat/m0-scaffolding` | CI green, Jaeger reachable |
| M1 | core: schema + gating + manual API | `feat/m1-core-schema` | 80% coverage, gating bug-proof |
| M2 | core: fetch hook | `feat/m2-fetch-hook` | byte-identical passthrough in unit tests |
| M3 | sdk: init + withAgent | `feat/m3-sdk-init` | stamping on every span |
| M4 | register: preload | `feat/m4-register-preload` | never crashes host, idempotent |
| M5 | Test B (Q1/Q2) | `feat/m5-test-b-verification` | all 5 criteria, Node + Bun |
| M6 | tier 2/3 + dedup | `feat/m6-tier2-sdk-patching` | one span per call, Test B regression green |
| M7 | Tests A + C | `feat/m7-test-a-c-equivalence` | contract holds, fixtures committed |
| M8 | Telemetry: R1 HTTP spans, R3 stream events, R6 code locations | `feat/m8-telemetry-enrichment` | stream endpoint distinguishable; `code.*` attrs on our spans; HTTP root span appears |
| M9 | `packages/extension`: OTLP receiver (:4319), span-store, postMessage fanout | `feat/m9-extension-receiver` | span emitted by bare app appears in webview; click openFile navigates |
| M10 | Webview renderer: swimlane layout, columns, arrows, action nodes, detail panel | `feat/m10-renderer` | Test D — fixture A through span-classifier + layout matches hand-derived message table |
| M11 | Extension wiring: loop fragments, trace sidebar, live streaming | `feat/m11-wiring` | Test E — bare app streams in real time, no layout shifts on append |
| M12 | MCP server + Test F | `feat/m12-mcp-test-f` | Test F — tool-call mid-conversation: new lifeline appends, click-to-span works; MCP `get_span` returns code location | Telemetry: R1 HTTP spans, R3 stream events, R6 code locations | `feat/m8-telemetry-enrichment` | stream endpoint distinguishable from JSON; `code.*` attrs on our spans; HTTP root span appears |
| M9 | `packages/extension`: OTLP receiver (:4319), span-store, postMessage fanout | `feat/m9-extension-receiver` | span emitted by bare app appears in webview OutputChannel; click openFile navigates |
| M10 | Webview renderer: swimlane layout, columns, arrows, action nodes, detail panel | `feat/m10-renderer` | Test D — fixture A through span-classifier + layout matches hand-derived message table |
| M11 | Extension wiring: loop fragments, trace sidebar, live streaming | `feat/m11-wiring` | Test E — bare app streams in real time, no layout shifts on append |
| M12 | MCP server + Test F | `feat/m12-mcp-test-f` | Test F — tool-call mid-conversation: new lifeline appends, click-to-span works; MCP `get_span` returns code location |
