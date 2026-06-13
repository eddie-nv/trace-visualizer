# Phase 1 Research Findings — Graph/Visualization Layer

Synthesized from two reference repos (cloned shallow into `workspace/` on 2026-06-12) plus our own trace fixtures:

| Source | Role | Checkout |
|---|---|---|
| `workspace/codag-visualizer` (codag-megalith/codag-visualizer) | Interactive rendering infrastructure: D3+ELK scene, live diff/patch updates, click-to-detail, theming, PNG export | `4630707` |
| `workspace/mermaid` (mermaid-js/mermaid) | Sequence diagram layout algorithm (`packages/mermaid/src/diagrams/sequence/` only) | `9f9566a` |
| `research/fixtures/test-a-reference.json` | AI SDK v6 native telemetry, one streamText weather turn with tool call (4 spans) | exported by `scripts/test-c/run.ts` |
| `research/fixtures/test-b-reference.json` | Bare app under our tier-1 shim, `/chat` + `/chat-stream` (1 span per trace) | **new** — exported by `scripts/test-b/export-fixture.ts` (added today) |

Full per-question reports with extended extracts: `research/raw/graph-1A-codag-visualizer.md`, `research/raw/graph-1B-mermaid-sequence.md`, `research/raw/graph-1C-span-mapping.md`. Paths below are relative to the respective repo root inside `workspace/`.

**Four findings that should shape Phase 2 — read these first:**

1. **Mermaid's sequence layout is ~80% an incremental algorithm wearing a batch coat.** The y axis is a pure fold over the message stream with a six-item state tuple (cursor, open-fragment stack, open-activation stack, extent, actor table, autonumber counter — `sequenceRenderer.ts:17-27`); the *only* fundamental batch dependency is horizontal (actor gaps widened by the widest future label, `sequenceRenderer.ts:1487-1690`). Fix column gaps + wrap/truncate labels and the band-height arithmetic is reusable essentially verbatim (raw 1B §5).
2. **Codag's three-tier re-render is the live-update pattern to port** (`messages.ts:360-424`): removals → 150ms container crossfade; additive-only → keyed D3 enter/update/exit; metadata-only → `Object.assign` into bound datums + reposition ("no blink"). Layout always runs off-DOM first. For an append-only sequence view, tier 2/3 cover nearly every frame.
3. **Both fixtures lack data the target visual needs.** No caller/channel participant (no HTTP server span), no per-chunk stream events (AI SDK gives only `firstChunk`/`finish`; **our shim emits no stream events at all** — `/chat-stream` is indistinguishable from `/chat` in fixture B), and no internal-step spans for the numbered notes. Five concrete requirements pushed back onto the telemetry layer in §4.
4. **Interleaving is real in the very first fixture**: the `ai.toolCall` span starts and ends *inside* the model round-1 `doStream` span's lifetime (tool executed while the stream is still open). The renderer cannot assume strict call/return stack nesting; timestamp-sorted emission with per-participant activation counters is required (raw 1C §2).

---

## 1. Codag: rendering / update / interaction infrastructure (raw 1A)

### 1.1 Scene structure

One full-size SVG → `<defs>` (dot-grid background patterns, arrowhead markers) → a single zoomable root `<g>` → sibling layer groups appended **in z-order**: `.groups` (workflow backgrounds) → `.edge-paths-container` → `.edge-labels-container` → `.nodes-container` (`frontend/src/webview-client/setup.ts:6-130`, ordering enforced in `main.ts:55-62`). d3-zoom with `scaleExtent([0.1, 10])`; a cheap LOD trick swaps the background pattern only when zoom crosses `k < 0.5` instead of every frame (`setup.ts:72-96`). Nodes are `<g class="node" data-node-id=…>` translated to centers, labels as HTML in `<foreignObject>` (`nodes.ts:143-186`); `data-node-id` is the lookup key for every targeted patch. All cross-module state lives in one mutable module (`state.ts:1-219`). Pan/zoom helpers + a minimap (second small SVG whose draggable viewport rect drives `zoom.transform`, `minimap.ts:31-210`).

**Port:** the SVG/layer/zoom skeleton and the layered-`<g>` z-ordering directly; it also replaces Mermaid's draw-order z-layering hacks (§2.4).

### 1.2 ELK integration (topology view)

`elkjs@0.11.0` bundled build, wrapped in `elk-layout.ts`. Full option set with their comments at `elk-layout.ts:14-54`: `layered`, direction `DOWN`, `edgeRouting: ORTHOGONAL`, crossing minimization `LAYER_SWEEP` + `TWO_SIDED` greedy switch, node placement + layering `NETWORK_SIMPLEX`, inline CENTER/MEDIAN edge labels (label size reserved in spacing), `mergeEdges: false` ("keep them separate like circuit traces"), `thoroughness: 10`. **No ports** — flat single-level graphs, edges attach to node boundaries. Node sizes are DOM-measured, not estimated: hidden-div measurement with binary-search for the tightest wrap width (`helpers.ts:30-116`), then a `<foreignObject>` overflow re-check after `document.fonts.ready` (`layout.ts:83-180`). ELK returns top-left coords + edge bend points; they convert to centers +30px margin and store routes keyed `${groupId}_${src}->${tgt}` (`elk-layout.ts:128-172`, `layout.ts:221`). One ELK run per workflow group, groups tiled by a custom radial corner-packing pass (`layout.ts:311-429`).

Consequence worth knowing: **node dragging is disabled** because ELK routes are static ("Drag disabled - ELK routes are static", `drag.ts:1,16-18`); the d3.drag handlers exist only to detect clicks via a 5px movement threshold (`drag.ts:20-40`).

**Port:** the option block verbatim for our topology view (it is tuned for labeled DAGs); DOM measurement; the centers+routes mapping. Skip the multi-group tiling (one conversation/window = one graph).

### 1.3 Graph data model

`WorkflowNode {id, label, type: 'step'|'llm'|'decision', description?, source?: SourceLocation{file,line,function}, model?, temperature?}`, `WorkflowEdge {source, target, label?, payload?, condition?, sourceLocation?}`, `GraphDiff {nodes:{added,removed,updated}, edges:{added,removed,updated}}` (`webview-client/types.ts:30-57, 126-137`; extension mirror in `types.ts:3-57`). Edge identity = composite key `${source}->${target}` (`graph-diff.ts:15`); node identity = `id`. This is the model we replace with Participant/Message (§3) — the `source: SourceLocation` field's role (click-through anchor + change matching) is played by the span ID in ours.

### 1.4 Live updates — the diff + patch mechanism (the most valuable extraction)

End-to-end: FS watcher → 2s debounce → tree-sitter diff → cached-graph patch → `updateGraph` postMessage → webview 150ms debounce with accumulation (last graph wins, pending IDs unioned, `messages.ts:21-33`) → map-based `computeGraphDiff` (`graph-diff.ts:4-90`: old/new `Map`s keyed by id / `${source}->${target}`, per-field `nodeChanged`/`edgeChanged` comparators) → `hasDiff()` short-circuit (`graph-diff.ts:92-102`) → **layout off-DOM first** ("calculates positions without touching DOM", `messages.ts:357-358`) → one of three render tiers (`messages.ts:360-424`):

- **Tier 1 (removals present):** render fresh containers after the old ones, crossfade opacity over 150ms, remove old.
- **Tier 2 (additive-only):** keyed D3 joins — `selectAll('.node').data(nodes, d => d.id)` → exit().remove() / enter().append(via shared `createNodeElement` factory) / merge().attr('transform', …) (`nodes.ts:655-699`, edges `edges.ts:570-721`).
- **Tier 3 (metadata-only):** `Object.assign` new fields into the *bound datums* in place, then reposition — no DOM rebuild, "no blink".

Two-phase optimistic feedback (`file-watching/handler.ts:69-88`): at T=0 highlight everything plausibly affected (`state: 'active'`, before any analysis), then refine to the precise change set after the debounce, with a 4s extension-side timer demoting `active` → `changed`. **This maps almost 1:1 onto SSE span batches** — e.g. mark a participant active the moment a span-start event arrives, refine when the span ends with full attributes.

The "changed = green" highlight is a **persistent CSS state machine, not a timeout flash**: classes `file-active` (animated neon-chase dash: `stroke-dasharray: 4 2` + `@keyframes neon-chase` shifting `stroke-dashoffset`, `styles.css:1509-1538`) and `file-changed` (static green) toggled directly on `.node-border` DOM (`nodes.ts:449-465`), with an `activeFileChanges` map **re-applied after every re-render** because tier-1/2 renders recreate DOM ("CSS classes are lost when DOM elements are recreated", `messages.ts:31-33, 453-457`). New nodes fade in 400ms; minimap dots pulse (`nodes.ts:244-252`, `minimap.ts:284-297`).

**Port:** the debounce-accumulate → diff → short-circuit → tiered-render pipeline; the highlight-state-survives-rerender map; the two-phase optimistic pattern.

### 1.5 Webview ↔ extension protocol (pattern for our SSE channel)

Plain JSON envelopes with a `command` discriminator; one `window.addEventListener('message')` switch (`messages.ts:48-581`); the extension **queues all messages until `webviewReady`** then flushes (`webview.ts:41-100`) — the exact pattern for an SSE backend buffering events until the browser subscribes (or replaying from Redis). Full 20+ message inventory in raw 1A §4; the load-bearing ones map as: `initGraph` (full state on connect) / `updateGraph` (incremental batch) / `fileStateChange` (ephemeral highlight state) / `focusNode`, and inbound `openFile` / `nodeSelected` / `webviewReady`.

### 1.6 Interactivity (click → detail panel → source)

`openPanel(nodeDatum)` writes the D3 datum into a static HTML side panel (title/type-badge/description), computes incoming/outgoing edges by filtering current graph data, renders clickable edge items; hover highlights the matching `.link` path, click animates `zoom.transform` to center the neighbor (`panel.ts:8-312`, `edges.ts:727-751`). Click-to-source is a plain `postMessage({command:'openFile', file, line})` (`panel.ts:58-65`); the extension resolves the path and calls `showTextDocument` + `revealRange` (`webview.ts:200-262`). **Ours:** identical flow with the span as the datum — click arrow → panel shows span attributes (tokens, latency, content when enabled) = click-to-span (Test F). Edge hover uses an invisible wide `.link-hover` hit path under the visible one (`edges.ts:256-294`) — port this; thin SVG lines are unclickable.

### 1.7 Theming

Zero theme-switching code: every color is `var(--vscode-*)` (36 distinct variables; dominant: `--vscode-foreground`, `--vscode-panel-border`, `--vscode-editor-background`, `--vscode-descriptionForeground`, `--vscode-editor-foreground`) in CSS and inline SVG attrs; VS Code live-updates the variables (raw 1A §7; e.g. `setup.ts:32,49,113`, `nodes.ts:45-175`). Deliberately hardcoded accents bypass the theme: LLM blue `#1976D2`, change-green `#00ff00`, HSL-hashed workflow colors. **Ours:** define our own `--tv-*` custom-property contract with a dark default (matching the reference screenshot) and a light override class — the standalone-browser equivalent of the same approach; a later VS Code wrapper just maps `--vscode-*` → `--tv-*`.

### 1.8 PNG export

They do **not** serialize the live SVG. `prepareSVGForExport()` rebuilds a standalone SVG: CSS variables resolved to concrete colors via `getComputedStyle` (`export.ts:25-40`), `<foreignObject>` HTML replaced with native `<text>/<tspan>` (foreignObject doesn't rasterize through `drawImage`), line breaks recovered by walking character rects with `document.createRange()` (`export.ts:101-149`). Then `XMLSerializer` → base64 data URL → `Image` → canvas `drawImage` → `toDataURL` (chosen over blob URLs / `toBlob` for webview reliability — `export.ts:708-774`), 16384px canvas guard. **Ours is cheaper:** if the sequence renderer avoids `foreignObject` from the start (SVG `<text>` + manual wrap — we control all label text), export reduces to resolve-vars → serialize → canvas, ~80 lines.

### 1.9 Not porting (and why)

Everything that *discovers* structure is irrelevant — our structure arrives ready-made from spans:

- The entire `backend/` — FastAPI + Gemini LLM inference to infer workflow graphs from code (`backend/main.py:31,175,245`); our "analysis" is trace ingestion, no inference.
- The frontend analysis pipeline (`frontend/src/api.ts`, `analyzer.ts`, `analysis/*`) and metadata/label hydration (`metadata-batcher.ts`, `metadata-builder.ts`) — span attributes already carry names.
- The tree-sitter call-graph stack (`frontend/src/tree-sitter/*`, `call-graph-extractor.ts`, `static-analyzer.ts`) — code parsing replaced by OTLP ingestion. (Note: tree-sitter lives in the *frontend* extension, not the backend, contrary to our initial assumption.)
- File picker, cache, cost tracking, and the file-watching trigger layer (`file-watching/handler.ts`) — though the latter's two-phase + debounce/diff/patch *shape* is kept as the design reference for SSE batches (§1.4).

Kept wholesale: `webview-client/` rendering/layout/diff/interaction (`setup.ts`, `elk-layout.ts`, `nodes.ts`, `edges.ts`, `graph-diff.ts`, `messages.ts`, `panel.ts`, `minimap.ts`, `export.ts`, `state.ts`) and the queue-until-ready pattern (`webview.ts:41-100`).

### 1.10 MCP server (carries over)

`packages/mcp-server/` (879 lines total) is a standalone stdio MCP server, **fully decoupled from the webview**: the extension writes `.vscode/codag-graph.json`; the server reads it, builds lookup indexes (`nodeById`, `fileToNodes`, `incoming/outgoingEdges` — `src/graph-loader.ts:42-79`), and hot-reloads via `fs.watch` on the directory with `watcher.unref()` so it never keeps the process alive (`graph-loader.ts:81-96`). It exposes one auto-injected resource (`codag://graph/summary`, markdown digest — `src/index.ts:25-36`) and six tools (`src/index.ts:42-102`): `get_task_context` (task description → relevant workflow files + data flow), `search_graph`, `list_workflows`, `get_workflow` (full topology + execution order via `topo-sort.ts`), `get_node` (type, **source location**, connections), `get_file_context`. Tool descriptions actively scope the agent's expectations ("ONLY covers LLM/AI code — does not know about non-LLM files", `index.ts:44`).

**Ours:** same architecture with the data source swapped — the server queries the ingestion backend / Redis state instead of a static JSON file (the loader's read-and-index-on-change pattern maps to subscribe-and-index-on-event). Trace-shaped tool set: `get_conversation` (sequence view model for a conversation id), `search_traces`, `list_agents` (participants + topology stats), `get_span` (attributes incl. code location → the agent-side analog of click-to-source), `get_agent_context` (which code files/functions an agent's spans touch — requires R6). The summary resource becomes "live agent topology digest".

---

## 2. Mermaid: sequence layout core loop and fragment math (raw 1B)

All paths `packages/mermaid/src/diagrams/sequence/`. Key defaults (`config.schema.yaml:2096-2215`): `activationWidth 10`, `actorMargin 50`, actor box `150×65`, `boxMargin 10`, `noteMargin 10`, `wrapPadding 10`, label box `50×20`.

### 2.1 The bounds singleton + y cursor

One mutable `bounds` object holds the complete inter-message state (`sequenceRenderer.ts:17-27`): diagram extent (`data`), the running y cursor (`verticalPos`), the **stack of open fragments** (`sequenceItems`), the **stack of open activations** (`activations`). The cursor only moves down — `bumpVerticalPos(bump)` is the single advance primitive (`:212-218`); the lone rewind is the `par_over` save/restore (`:202-211`). Every drawn shape calls `bounds.insert(x1,y1,x2,y2)` (`:135-147`), which min/max-folds the extent **and** notifies every open fragment/activation.

### 2.2 The core message loop

`draw()` (`:1042-1474`) walks ONE flat message list; fragments, activations, and notes are pseudo-messages with `LINETYPE` codes (`sequenceDb.ts:34-96`) — the renderer has no tree. Condensed:

```
y = 0
for msg in messages:                  # flat list
  ARROW:        y += 10 + labelHeight + boxMargin (self-msg: +30 for the loop-back curve);
                line drawn at the BOTTOM of the band (label above);  boundMessage :406-450
  NOTE:         y += boxMargin + textHeight + 2*noteMargin;          drawNote :242-285
  ACTIVE_START: push {x = lifelineCenter + 5*stackDepth, starty=y}   :148-160
  ACTIVE_END:   pop per-actor LIFO; draw rect starty..y              :1120-1137
  LOOP/ALT/OPT_START: y += boxMargin; push {starty=y, startx/stopx=undefined};
                y += boxMargin + boxTextMargin + max(titleHeight,20) # header ≈35px,  :915-933
  ALT_ELSE:     record divider {y} + title on the OPEN fragment      :194-201
  *_END:        pop; draw 4-sided box + dashed dividers; y = box bottom  :1175-1180
```

A plain one-line arrow consumes ≈ `textHeight + lineHeight + 10` px of vertical band; the exact arithmetic is `boundMessage` (`:406-450`) — **reusable verbatim**.

### 2.3 Fragment envelope math

Fragments open with `starty` fixed but x-extent `undefined` (`createLoop`, `:170-188`). Every inner `insert` fans out through `updateBounds` (`:105-134`), expanding each open fragment by `n × boxMargin` where `n` = nesting depth from the top of the stack — outer boxes wrap inner boxes with growing padding, and **nesting needs no special code** (the inner box's own draw `insert`s into the outer). `else`/`and` section dividers just record `{y, title}` on the open fragment (`addSectionToLoop`, `:194-201`). The box is drawn only at `*_END`, then the cursor snaps to the (margin-inflated) box bottom (`:1175-1180`). Drawing = 4 lines + dashed dividers + pentagon label box + centered `[title]` (`svgDraw.js:1389-1470`).

### 2.4 Arrows, activations, notes

- **Solid vs dashed** = `stroke-dasharray: '3, 3'` on the DOTTED* line types (`:548-567`); arrowheads are per-diagram SVG `<marker>` defs selected by LINETYPE (`:627-643`; filled triangle / filled point / cross / none-for-OPEN, shapes in `svgDraw.js:1551-1631`). Our mapping: request = `SOLID` (filled triangle), return = `DOTTED` (the conventional return), span-error = `DOTTED_CROSS`.
- **Arrow endpoints attach to activation outer edges, not lifeline centers** (`activationBounds`, `:895-913`; `buildMessageModel`, `:1897-1901`).
- **Self-messages** (`startx === stopx`): cubic Bézier bulging 60px right, returning 20px lower (`:509-530`); cost = label + boxMargin + 30px extra (`:425-438`).
- **Activations**: nested bars on the same lifeline offset right 5px each (`newActivation`, `:148-160`); per-actor LIFO close (`endActivation` via `lastIndexOf`, `:161-168`); the rect is drawn at close from `starty` to cursor, with a ≤12px minimum-height retro-fix (`activeEnd`, `:1120-1137`). Activations do not advance the cursor.
- **Notes**: x/width per placement (RIGHTOF/LEFTOF/OVER-one/OVER-two, `buildNoteModel`, `:1692-1762`); y purely cursor-driven, cost = `boxMargin + textHeight + 2*noteMargin` (`drawNote`, `:242-285`). Our notes (R4 in §4) anchor `OVER` the agent lifeline.

### 2.5 Static vs streaming — the verdict

Mermaid hard-codes three full-list pre-passes before the first pixel: (1) measure every message label → max width per actor gap (`getMaxMessageWidthPerActor`, `:1487-1586`); (2) freeze every `actor.x` as a running sum of label-widened margins (`calculateActorMargins` `:1613-1690`, `addActorRenderingData` `:742-810`); (3) replay the whole list to learn each fragment's final width for title wrapping at open time + cache all message x-geometry (`calculateLoopBounds`, `:2032-2142`). Plus post-passes: deferred arrow drawing for z-order (`:1388-1390`), mirrored footer actors, lifeline `y2` fixed once total height is known (`fixLifeLineHeights`, `svgDraw.js:317-330`), viewBox last (`:1416-1471`).

**But the y model is genuinely append-only** (`bumpVerticalPos` only adds; nothing about message N changes the y of messages 1..N−1, save two bounded local retro-edits: the activation min-height fix `:1122-1125` and created/destroyed actor shifts `:1007-1029`). The complete inter-append state is exactly what `bounds` already holds — cursor, open-fragment stack, open-activation stack, extent, frozen actor table, autonumber counter (raw 1B §5.3).

**Changes required for streaming** (raw 1B §5.4): fix column gaps (constant/quantized) and wrap/truncate labels to the gap instead of widening gaps to labels (Mermaid already has the wrap path, `:1998-2002`); append new lifelines at the right edge (running-sum x makes this O(1)) and accept that "should-sit-between" actors land rightmost; draw a provisional open-fragment box finalized on close (the envelope math is already incremental — only draw timing changes); replace draw-order z-layering with Codag-style layered `<g>` groups (§1.1); update lifeline `y2`/viewBox per append (cheap attribute writes); drop `mirrorActors`. This directly satisfies Test E's "existing messages never move when new ones append".

---

## 3. Span → diagram derivation rules (raw 1C — hand-verified against both fixtures)

### 3.1 Participants (lifeline columns)

Per span, priority: **(1)** `agentgraph.agent.id` → agent; **(2)** `agentgraph.agent.fingerprint` → agent-cluster; **(3)** resource `service.name` → service — EXCEPT spans matching the DESIGN §2.3 LLM contract (`gen_ai.request.model` + usage tokens; AI SDK v6 fallback `ai.model.provider`/`ai.model.id`) → **model participant** `provider:model`, and tool spans (`ai.toolCall.name` / v7 `gen_ai.tool.name`) → **tool participant**. For an LLM/tool span, the *source* participant comes from the span's own agent-identity attrs (fingerprint on fixture B's spans), falling back to the parent span's participant (fixture A's native spans carry no `agentgraph.*`).

**Deviation from the task brief, flagged for review:** fingerprint ranks *above* service name (brief proposed agent.id → service → fingerprint). With service in the middle, every unconfigured multi-agent service collapses into one lifeline and the fingerprint (whose whole purpose is splitting those, DESIGN Q6) would never fire.

Applied: fixture A → 3 columns (`ta-mqbcptif-1zdf` runtime │ `claude-mock-model` │ `getWeather`); fixture B → 2 columns (agent-cluster `6f7dec59198ff155` │ `claude-mock-model`). Gotcha caught by hand-derivation: fixture A's root `ai.streamText` span carries `ai.model.id` but must NOT become a model column — it lacks `gen_ai.usage.*`; only the `doStream` children pass the §2.3 contract. The contract classifies correctly; a naive "has model attr" rule does not.

### 3.2 Messages (arrows)

Span S from source participant src(S) to P(S): **solid arrow** src→P(S) at `startTime`; **dashed return** P(S)→src at `startTime + duration` carrying the outcome (finish reason, usage, content-gated text — the span IS the detail-panel payload for the return arrow). Same-participant children render as activations/notes, not arrows. All arrows + span events globally **sorted by timestamp** — fixture A proves strict nesting is violated (finding 4 above). Full hand-derived 12-row message table for fixture A (timestamps, arrow kinds, labels, source span IDs) in raw 1C §2 — this is the Test D assertion target. Fixture B: one solid + one dashed per trace, two columns, nothing else.

### 3.3 Fragments and notes

- `loop` fragment ⇐ runs of ≥2 same-operation sibling spans under one parent (fixture A: 2× `doStream` under `streamText` = tool-use rounds). Derivable today.
- `streaming` fragment (degraded) ⇐ span-event pair `ai.stream.firstChunk` → `ai.stream.finish` (fixture A doStream logs at 1781294439663084/1781294439699714). Renders as a band on the model activation, NOT a per-chunk loop — chunk events don't exist (R2/R3).
- Notes ⇐ span events / same-participant child spans. Neither fixture has any (R4).
- `alt`/`opt`: no span analog (spans record what happened, not branches not taken) — out of scope.

### 3.4 Aggregate (topology) view

Nodes = participants (typed agent/cluster/service/model/tool/channel); edges = (src, dst) pairs over the window's request arrows, weight = message count, annotated with token sums and latency percentiles. Fixture A: runtime→model ×2 (34 in / 84 out tokens), runtime→getWeather ×1. This is precisely the labeled-DAG shape Codag's ELK option block (§1.2) is tuned for — **the topology view reuses Codag's layout + render pipeline directly**; only the data model is swapped.

## 4. Requirements pushed back onto the telemetry layer

| # | Gap (evidence) | Requirement |
|---|---|---|
| R1 | No caller/channel participant in either fixture (fixture A root = bare `ai.streamText`; fixture B root = the LLM CLIENT span itself) — the reference screenshot's leftmost user/channel lifeline cannot be derived | Inbound HTTP server span or `agentgraph.channel.type` stamping (DESIGN §2.2) |
| R2 | No per-chunk stream events anywhere; AI SDK emits only `firstChunk`/`finish` | If the chunk-loop visual is wanted: periodic `gen_ai.stream.chunk` progress events; else accept the firstChunk→finish band |
| R3 | **Our shim emits no stream events at all** — fixture B `/chat-stream` ≡ `/chat` | Tier-1 hook adds `firstChunk`/`finish` span events (it already parses SSE for usage parity, so the hook points exist) |
| R4 | No internal-step spans/events → no numbered notes ("1. Resolve agents") | Lightweight `step(name)` event API on the SDK (or `withAgent` auto-events); notes are schema-driven, not heuristic |
| R5 | Preload leg has no `agent.id` → lifeline would be labeled by fingerprint hash | Display contract: fingerprint participants labeled service-name + short hash, upgraded in place when a later span maps the fingerprint to an `agent.id` |
| R6 | **No code locations on any span in either fixture** — click-to-source ("click a node → where in code this happens") has nothing to navigate to. Codag gets `source: {file, line}` from tree-sitter; our spans come from runtime hooks | Shim captures the caller frame at span creation (walk `new Error().stack` past internal/SDK frames) and stamps OTel semconv `code.file.path`, `code.line.number`, `code.function.name`. Coverage caveat: only OUR spans get this — AI SDK native spans (Test A) carry at best `ai.telemetry.functionId` as a weak search-fallback. Cost: stack capture is ~µs per LLM call (rare events), acceptable at tier 1 |

---

## 5. Decisions and open questions for Phase 2

**DECIDED (user, 2026-06-12): v1 is a VS Code extension + webview, thin-host architecture.** Rationale: the product's core interaction is click-node → reveal code (needs the extension host: `showTextDocument` + `revealRange`, path resolution — §1.6), and the MCP server (§1.10) registers naturally from the same extension. Constraint: the renderer + ingestion backend stay frontend-agnostic — the webview loads the same browser bundle that a standalone app would, talks SSE to the backend for trace data, and uses postMessage ONLY for editor concerns (`openFile`, theme); a later standalone wrapper swaps the postMessage bridge for `vscode://file/<path>:<line>` deep links.

**View-model implication (user, 2026-06-12):** the target visual is a **DAG shaped like a sequence flow** — services/agents labeled as columns on top, time flowing downward, **clickable nodes for actions** placed at (participant column, time row), edges showing causality. This is a swimlane DAG, not a pure Mermaid arrows-between-lifelines diagram: the view model needs an `ActionNode` (span → node at column×time, click target, code location per R6) alongside Message arrows; Mermaid's y-cursor/band math (§2.2) still drives the time axis, Codag's node rendering + click + panel (§1.1, §1.4, §1.6) renders the nodes.

Open:

1. Participant priority deviation (§3.1, fingerprint above service) — confirm or revert.
2. Mid-stream lifeline insertion: always-append-rightmost (Test F minimum: "column inserted without breaking earlier messages" — append satisfies this) vs re-layout on insertion. Recommend append-only for v1; Mermaid's running-sum x makes it O(1) (raw 1B §5.4 item 2).
3. Whether Test D's renderer comparison uses fixture A as-is (no caller column until R1 lands) — the hand-derived table in raw 1C §2 assumes as-is.
4. MCP tool surface for v1 (§1.10 proposes 5 tools + summary resource) — trim or extend.
