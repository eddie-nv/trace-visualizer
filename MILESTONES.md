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
