# Repo research: codag-visualizer (Phase 1A)

- **Repo:** `workspace/codag-visualizer` (VS Code extension "Codag" — interactive LLM-workflow code-structure graph in a webview)
- **Checkout commit:** `4630707` (`46307079876d548c1e55c739033087bad72de0e8`, authored 2026-02-10)
- **Clone date:** 2026-06-12 (fresh shallow clone)
- **Stack:** TypeScript VS Code extension (`frontend/`), webview client bundled to `out/webview-client/main.js`, vendored D3 v7 (`frontend/media/webview/d3.v7.min.js`), `elkjs@^0.11.0` + `dagre@^0.8.5` (dagre is vestigial; ELK replaced it) + `web-tree-sitter` (`frontend/package.json:86-92`). Python FastAPI + Gemini backend (`backend/`).

All paths relative to repo root.

---

## 1. Rendering pipeline

Everything lives in `frontend/src/webview-client/`. D3 is loaded as a global `<script>` (vendored `frontend/media/webview/d3.v7.min.js`, injected in `frontend/src/webview.ts:611-613`), so every module declares `declare const d3: any;` rather than importing it (e.g. `frontend/src/webview-client/setup.ts:4`).

**Scene structure: one full-size SVG, one zoomable root `<g>`, then sibling layer groups appended in z-order.** The SVG/zoom setup is `setupSVG()` in `frontend/src/webview-client/setup.ts:6-130`:

```ts
// frontend/src/webview-client/setup.ts:10-13, 52-63, 75-99
const svg = d3.select('#graph')
    .append('svg')
    .attr('width', '100%')
    .attr('height', '100%');
...
// Main group for all graph elements (zoomable, includes pegboard)
const g = svg.append('g');

// Add pegboard background inside transform group
const pegboardBg = g.append('rect')
    .attr('x', -50000).attr('y', -50000)
    .attr('width', 100000).attr('height', 100000)
    .attr('fill', 'url(#pegboard-fine)')
    .attr('class', 'pegboard-bg')
    .lower();
...
const zoom = d3.zoom()
    .scaleExtent([0.1, 10])
    .on('zoom', (event: any) => {
        g.attr('transform', event.transform);
        // Only update pattern when crossing threshold (not every frame)
        const k = event.transform.k;
        const newZone: 'fine' | 'coarse' = k < 0.5 ? 'coarse' : 'fine';
        if (newZone !== lastZoomZone) { ... swap pegboard pattern + opacity ... }
    });
svg.call(zoom).on('dblclick.zoom', null);
```

Notable details:
- A `<defs>` block holds two dot-grid `<pattern>`s ("pegboard", 20px fine / 40px coarse) plus `arrowhead` and `arrowhead-start` markers for uni/bidirectional edges (`setup.ts:16-50`, `setup.ts:101-127`). Markers use `fill: var(--vscode-editor-foreground)` so arrows follow the theme (`setup.ts:113`).
- LOD trick: the zoom handler swaps the background pattern only when crossing the `k < 0.5` threshold instead of on every frame (`setup.ts:72-96`) — a cheap level-of-detail mechanism worth copying.
- Layer groups are NOT created in setup; they are appended to `g` by the render functions in z-order: workflow group backgrounds (`.groups`, `frontend/src/webview-client/groups.ts`), then `g.append('g').attr('class', 'edge-paths-container')` (`edges.ts:234`), `'edge-labels-container'` (`edges.ts:373`), then `'nodes-container'` (`nodes.ts:19-21`). The init sequence enforces the order: `renderGroups(); renderEdges(); renderNodes(...)` (`frontend/src/webview-client/main.ts:55-62`, with the comment "Render groups (before edges/nodes for z-index)").
- Initial render flow (`main.ts:26-122`): `acquireVsCodeApi()` → read `window.__GRAPH_DATA__` (injected into HTML by the extension, `webview.ts:645-651`) → `detectWorkflowGroups()` → `setupSVG()` → `await layoutWorkflows(defs)` (ELK, async) → render layers → `fitToScreen()` → `vscode.postMessage({ command: 'webviewReady' })` (`main.ts:86`).
- All cross-module state (svg/g/zoom selections, graph data, ELK route maps, expanded nodes) lives in a single mutable module `frontend/src/webview-client/state.ts:1-219` with setter functions.
- Each node is a `<g class="node" data-node-id=...>` translated to its center; node label text is HTML inside `<foreignObject>` for wrapping/hyphenation (`nodes.ts:143-186`). `data-node-id` attributes are the lookup key for all targeted patches (`nodes.ts:26`).
- Pan/zoom helpers: `fitToScreen()` and zoom buttons call `svg.transition().call(zoom.scaleBy, 1.3)` / `zoom.transform` (`frontend/src/webview-client/controls.ts:47-52, 82-116`). A minimap (`frontend/src/webview-client/minimap.ts:31-210`) is a second small SVG with a draggable viewport rect that drives `zoom.transform` (`minimap.ts:163`).

## 2. Layout integration (ELK)

ELK is wrapped in `frontend/src/webview-client/elk-layout.ts` using the bundled build:

```ts
// frontend/src/webview-client/elk-layout.ts:1-12
/**
 * ELK Layout Engine
 *
 * Replaces dagre for graph layout. ELK provides:
 * - Better edge routing (orthogonal, avoiding nodes)
 * - Active maintenance (dagre unmaintained since 2018)
 * - More layout algorithms and configuration options
 */
import ELK, { ElkNode, ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
const elk = new ELK();
```

**Complete option set, verbatim with their comments** (`elk-layout.ts:14-54`):

```ts
const DEFAULT_LAYOUT_OPTIONS: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',

    // Node spacing - comfortable for unlabeled edges, labels handled separately
    'elk.layered.spacing.nodeNodeBetweenLayers': '35',  // Vertical gap between layers
    'elk.spacing.nodeNode': '20',                        // Horizontal gap within layer

    // Edge routing - ORTHOGONAL for square edges that avoid nodes
    'elk.edgeRouting': 'ORTHOGONAL',
    'elk.layered.spacing.edgeNodeBetweenLayers': '15',  // Space between edges and nodes vertically
    'elk.layered.spacing.edgeEdgeBetweenLayers': '20',  // Vertical spacing between parallel edges (room for labels)
    'elk.spacing.edgeEdge': '20',                        // Horizontal spacing between parallel edges
    'elk.spacing.edgeNode': '12',                        // Minimum edge-to-node distance

    // Crossing minimization - reduce edge overlaps
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',

    // Node placement for better edge routing
    'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',

    // Layering strategy
    'elk.layered.layering.strategy': 'NETWORK_SIMPLEX',

    // Edge label placement - inline=true accounts for label size in node spacing
    'elk.edgeLabels.inline': 'true',
    'elk.edgeLabels.placement': 'CENTER',
    'elk.layered.edgeLabels.centerLabelPlacementStrategy': 'MEDIAN',
    'elk.spacing.labelLabel': '12',
    'elk.spacing.labelNode': '8',

    // DO NOT merge edges - keep them separate like circuit traces
    'elk.layered.mergeEdges': 'false',
    'elk.layered.mergeHierarchyEdges': 'false',

    // Higher thoroughness = better routing quality
    'elk.layered.thoroughness': '10',
};
```

Per-node options exist too: workflow-title nodes get `'elk.layering.layerConstraint': 'FIRST'` and `'elk.priority': '100'` to pin them to the top layer (`frontend/src/webview-client/layout.ts:199-205`). **No port constraints are used anywhere** — edges attach to node boundaries, not ports.

**ELK graph input** (`elk-layout.ts:92-126`): flat single-level graph `{ id: 'root', layoutOptions, children, edges }`. Children carry pre-measured `width`/`height`; edges carry `sources: [src], targets: [tgt]` and, if labeled, an estimated-size label (`estimateLabelWidth = max(40, label.length * 7 + 16)`, height 18 — `elk-layout.ts:75-80`) so ELK reserves space and returns a label position.

**Node sizes are measured in the DOM, not estimated.** Two-stage measurement:
1. `measureNodeDimensions()` (`frontend/src/webview-client/helpers.ts:30-116`) appends a hidden `<div>` to `document.body`, measures single-line width; if it exceeds `maxWidth - 8` (default max 240) it wraps and **binary-searches the minimum width that doesn't add a line** (`helpers.ts:88-108`). Decision (hexagon) nodes get `width * 1.2` for the pointed ends (`layout.ts:73-77`).
2. "PASS 0.5" overflow check (`layout.ts:83-180`): after `await document.fonts.ready` (custom DM Sans font changes metrics), it renders temporary `<foreignObject>`s at `translate(-5000,-5000)` that exactly mirror the real node markup, forces layout (`void spanEl.offsetHeight`), detects overflow, and binary-searches a corrected width/height. This eliminates clipped labels.

**Result mapping** (`elk-layout.ts:128-172`): ELK returns top-left coords; they convert to **centers** and add a 30px margin:

```ts
// frontend/src/webview-client/elk-layout.ts:130-155
const MARGIN = 30;   // Add margin equivalent to dagre's marginx/marginy (30px)
for (const child of result.children || []) {
    // ELK returns top-left corner, we need center
    const centerX = (child.x || 0) + (child.width || 0) / 2 + MARGIN;
    ...
}
for (const edge of (result.edges || []) as ElkExtendedEdge[]) {
    const section = edge.sections?.[0];
    if (section && section.startPoint && section.endPoint) {
        edgeRoutes.set(edge.id, {
            startPoint: {...}, endPoint: {...},
            bendPoints: (section.bendPoints || []).map(bp => ({ x: bp.x + MARGIN, y: bp.y + MARGIN })),
        });
    }
    ... // labels: top-left -> center conversion (elk-layout.ts:158-168)
}
```

**Multi-graph tiling:** `layoutWorkflows()` (`frontend/src/webview-client/layout.ts:50-557`) runs **one ELK layout per workflow group** (groups with <3 nodes are skipped, `layout.ts:189`), computes each group's bounds (expanded to include edge bend points + 8px, `layout.ts:262-271`), then PASS 2 packs the groups with a custom radial corner-packing algorithm (largest at center, candidates at corners of placed boxes, pick valid corner closest to centroid — `layout.ts:311-429`), and PASS 3 translates node positions, edge routes, and label positions into global coordinates (`layout.ts:432-470`). Node positions are also `snapToGrid`-ed (`layout.ts:238`).

**Routes → paths:** edge routes are stored in `state.elkEdgeRoutes` keyed `${groupId}_${source}->${target}` (`layout.ts:221`, `edges.ts:80-95`). `generateElkEdgePath()` builds `M start, L bend..., L end` polylines, shortening the last segment by `ARROW_HEAD_LENGTH` so the marker tip lands on the node border (`frontend/src/webview-client/edges.ts:16-43`). Routes are validated for NaN/zero-length before render (`edges.ts:48-74`). **Because routes are static ELK output, node dragging is disabled** — the drag handlers exist only to detect clicks: "Drag disabled - ELK routes are static and cannot update dynamically" (`frontend/src/webview-client/drag.ts:1,16-18`).

## 3. Graph data model

Two parallel definitions: extension-side `frontend/src/types.ts` and webview-side `frontend/src/webview-client/types.ts` (the webview one re-exports `SourceLocation` and adds D3 fields). Verbatim:

```ts
// frontend/src/types.ts:3-8
export interface SourceLocation {
    file: string;
    line: number;
    function?: string;
}
```

```ts
// frontend/src/webview-client/types.ts:30-57
export interface WorkflowNode {
    id: string;
    label: string;
    type: 'step' | 'llm' | 'decision' | string;  // 3 main types, string for backward compat
    description?: string;
    source?: SourceLocation;
    model?: string;  // For LLM nodes: the model name
    temperature?: number;
    x?: number;
    y?: number;
    fx?: number;
    fy?: number;
}

export interface EdgePayload {
    name: string;
    type: string;
    description: string;
}

export interface WorkflowEdge {
    source: string;
    target: string;
    label?: string;           // Descriptive (only for decisions/API calls)
    payload?: EdgePayload;    // Data contract
    condition?: string;       // For decision branches
    sourceLocation?: SourceLocation;
}
```

```ts
// frontend/src/webview-client/types.ts:74-79
export interface WorkflowGraph {
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
    llms_detected: string[];
    workflows: Workflow[];
}
```

```ts
// frontend/src/webview-client/types.ts:126-137
export interface GraphDiff {
    nodes: { added: WorkflowNode[]; removed: string[]; updated: WorkflowNode[]; };
    edges: { added: WorkflowEdge[]; removed: WorkflowEdge[]; updated: WorkflowEdge[]; };
}
```

Node metadata: `source` (file/line/function — drives click-to-source AND file-change highlighting matching), `type`/`kind`, `label`, `description`, LLM-specific `model`/`temperature`. Runtime-only fields are underscore-prefixed and attached ad hoc: `_textWidth`/`_textHeight` (foreignObject area, `layout.ts:70-72`), `width`/`height` (measured), `_refTargetId`/`_refWorkflowName` for cross-workflow reference nodes (`panel.ts:74`). Edges similarly get `_originalSource`/`_originalTarget` when re-targeted to collapsed-component placeholders (`edges.ts:172-180`). UI grouping types `Workflow`, `WorkflowComponent`, `WorkflowGroup` (collapsed flag, color, bounds, level) are at `webview-client/types.ts:59-117`. The extension-side `frontend/src/types.ts:17-57` mirrors node/edge/graph plus `ComponentMetadata`/`WorkflowMetadata`. Edge identity throughout is the composite key `${source}->${target}` (`graph-diff.ts:15`); node identity is `id`.

## 4. Webview ↔ extension protocol

Plain `postMessage` JSON envelopes with a `command` discriminator. Extension side: `WebviewManager` in `frontend/src/webview.ts` (sender helpers + `onDidReceiveMessage` at `webview.ts:195-348`). Webview side: one `window.addEventListener('message')` switch in `frontend/src/webview-client/messages.ts:48-581`; sends via `state.vscode.postMessage` after `acquireVsCodeApi()` (`main.ts:28`). The extension **queues messages until the webview signals readiness**: `postMessage()` buffers into `pendingMessages` until `webviewReady` arrives, then flushes (`webview.ts:41-51, 56-100`) — essential because webview HTML resets are common.

### Extension → webview (sent from `webview.ts`, handled in `messages.ts`)

| command | payload | sent | handled |
|---|---|---|---|
| `initGraph` | `{graph}` — full re-init from cache | webview.ts:518-523 | messages.ts:531-579 |
| `updateGraph` | `{graph, preserveState: true, pendingNodeIds?, fileChange?: {filePath, functions}}` | webview.ts:505-513 | messages.ts:281-468 |
| `clearGraph` | `{}` | webview.ts:528-532 | messages.ts:523-529 |
| `fileStateChange` | `{changes: [{filePath, functions?, state: 'active'\|'changed'\|'unchanged'}]}` | webview.ts:170-179 | messages.ts:183-205 |
| `hydrateLabels` | `{filePath, labels: Record<fn,label>, descriptions}` | webview.ts:559-566 | messages.ts:238-279 |
| `focusNode` | `{nodeId}` | webview.ts:542-547 | messages.ts:470-493 |
| `focusWorkflow` | `{workflowName}` | webview.ts:549-554 | messages.ts:495-499 |
| `showLoading` / `updateLoadingText` | `{text, subtext?}` | webview.ts:449, 452-454 | messages.ts:55-63 |
| `updateProgress` (legacy) | `{current, total}` | webview.ts:456-458 | messages.ts:66-72 |
| `batchProgress` | `{completed, total, filesAnalyzed, elapsed}` | webview.ts:463-492 | messages.ts:74-82 |
| `showProgressOverlay` / `hideProgressOverlay` | `{text?}` | webview.ts:534-540 | messages.ts:84-100 |
| `analysisStarted` / `analysisComplete` | `{success, error?, filesAnalyzed?, batchCount?, elapsed?}` | webview.ts:129-146 | messages.ts:102-139 |
| `warning` / `showNotification` | `{message, type?, dismissMs?}` | webview.ts:148-153, 184-193 | messages.ts:141-147, 207-214 |
| `backendError` / `apiKeyError` / `dismissErrorOverlays` | `{reason?: 'missing'\|'invalid'}` | webview.ts:155-165 | messages.ts:149-181 |
| `setWorkspaceName` | `{name}` (org/repo from git remote, for export watermark) | webview.ts:89-93 | messages.ts:93-95 |
| `showFilePicker` / `closeFilePicker` | `{tree, totalFiles, pricing}` | webview.ts:398-409, 353-355 | messages.ts:501-521 |
| `exportSuccess` / `exportCancelled` / `exportError` | `{path}` / `{}` / `{error}` | webview.ts:334-341 | messages.ts:216-236 |

### Webview → extension (handled in `webview.ts:198-344`)

| command | payload | sent | handled |
|---|---|---|---|
| `webviewReady` | `{}` | main.ts:86 | webview.ts:299-301 |
| `openFile` | `{file, line}` — click-to-source | panel.ts:60-64, edges.ts:287-293, edges.ts:692-700 | webview.ts:200-262 |
| `nodeSelected` | `{nodeId, nodeLabel, nodeType}` | panel.ts:201-206 | webview.ts:265-270 |
| `nodeDeselected` | `{}` | panel.ts:321 | webview.ts:271-276 |
| `workflowVisibilityChanged` | `{expandedWorkflowIds}` | visibility.ts | webview.ts:277-280 |
| `viewportChanged` | `{visibleNodeIds}` | minimap.ts:275 | webview.ts:281-284 |
| `refreshAnalysis` | `{}` → runs `codag.refresh` | controls.ts | webview.ts:263-264 |
| `retryAnalysis` | `{}` → runs `codag.open` | messages.ts:43 | webview.ts:297-298 |
| `openAnalyzePanel` | `{}` → `codag.showFilePicker` | controls.ts:28 | webview.ts:291-293 |
| `filePickerResult` | `{selectedPaths}` (resolves a stored Promise resolver) | messages.ts:510-513 | webview.ts:285-290 |
| `clearCacheAndReanalyze` | `{paths}` | file-picker.ts:468 | webview.ts:294-296 |
| `saveExport` | `{data: <base64>, suggestedName}` | export.ts:781-785 | webview.ts:302-342 |

## 5. Live updates (the core mechanism)

End-to-end flow: **FS watcher → debounce → tree-sitter call-graph diff (no LLM) → cached-graph patch → `updateGraph` postMessage → webview-side graph diff → tiered re-render (crossfade / D3 join / position-only) → CSS-class highlight states**.

### 5.0 Extension side: watcher + two-phase feedback

`vscode.workspace.createFileSystemWatcher('**/*.{py,ts,js,...}')` plus `onDidSaveTextDocument`, both funneling into `scheduleFileAnalysis` (`frontend/src/extension.ts:131-239`; debounce `DEBOUNCE_MS = 2000` from `frontend/src/config.ts:30-33`, `activeToChangedMs: 4000` at `extension.ts:223`).

`scheduleFileAnalysis` (`frontend/src/file-watching/handler.ts:47-179`) implements a deliberate two-phase UX:

```ts
// frontend/src/file-watching/handler.ts:69-88
// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: INSTANT VISUAL FEEDBACK (T=0ms)
// Show "file being edited" indicator IMMEDIATELY before debounce.
// ═══════════════════════════════════════════════════════════════════════════
const cachedGraph = cache.getCachedGraphSync();
const fileHasNodesInGraph = cachedGraph?.nodes.some(n => n.source?.file === relativePath);
if (fileHasNodesInGraph) {
    clearActivelyEditing(filePath);
    // Instant feedback: highlight ALL nodes from this file
    // (We don't know which specific functions changed yet)
    webview.notifyFileStateChange([{ filePath: relativePath, state: 'active' }]);
}
```

After the debounce it runs `performLocalUpdate` (`frontend/src/file-watching/local-update.ts:30-159`): read the file, `extractCallGraph()` via tree-sitter, `diffCallGraphs(old, new)` to get `addedFunctions/removedFunctions/modifiedFunctions/addedEdges/removedEdges` (`local-update.ts:53-60`), then `applyLocalUpdate()` patches the **cached** graph (deep-clone first — `frontend/src/local-graph-updater.ts:116-145`: remove nodes+their edges for removed functions, add nodes for added functions before wiring edges, mark new nodes `needsMetadata` for later LLM label hydration). The patched graph is pushed only when structure actually changed:

```ts
// frontend/src/file-watching/handler.ts:105-122
const hasStructuralChanges = localResult.nodesAdded.length > 0 || localResult.nodesRemoved.length > 0 ||
    localResult.edgesAdded > 0 || localResult.edgesRemoved > 0;
if (hasStructuralChanges) {
    webview.updateGraph(withHttpEdges(localResult.graph, log)!, localResult.needsMetadata);
    log(`Graph updated locally (instant) via tree-sitter`);
    if (localResult.needsMetadata.length > 0) { ... metadataBatcher.queueFile(...) ... }
}
```

PHASE 2 then refines the highlight to only the changed functions, and a 4s inactivity timer demotes `'active'` → `'changed'` (`handler.ts:124-160`). If the local update can't handle it and the file was previously analyzed, it falls back to full LLM analysis (`handler.ts:161-175`).

### 5.1 Webview side: debounce + diff

`updateGraph` messages are debounced 150ms with accumulation — last graph wins, `pendingNodeIds` are unioned across bursts (`frontend/src/webview-client/messages.ts:21-33, 281-307`):

```ts
// frontend/src/webview-client/messages.ts:21-26
// Debounce state for updateGraph to prevent jitter from rapid updates
let pendingGraphUpdate: any = null;
let pendingNodeIdsForUpdate: string[] = [];  // Nodes awaiting metadata
let pendingFileChange: { filePath: string; functions: string[] } | null = null;
let updateDebounceTimer: number | null = null;
const UPDATE_DEBOUNCE_MS = 150;
```

The diff is a straightforward map-based set comparison, `computeGraphDiff` in `frontend/src/webview-client/graph-diff.ts:4-90`:

```ts
// frontend/src/webview-client/graph-diff.ts:12-17, 23-54, 75-84
const oldNodeMap = new Map(oldGraph.nodes.map(n => [n.id, n]));
const newNodeMap = new Map(newGraph.nodes.map(n => [n.id, n]));
const edgeKey = (e: WorkflowEdge) => `${e.source}->${e.target}`;
const oldEdgeMap = new Map(oldGraph.edges.map(e => [edgeKey(e), e]));
...
newGraph.nodes.forEach(newNode => {
    const oldNode = oldNodeMap.get(newNode.id);
    if (!oldNode) diff.nodes.added.push(newNode);
    else if (nodeChanged(oldNode, newNode)) diff.nodes.updated.push(newNode);
});
oldGraph.nodes.forEach(oldNode => {
    if (!newNodeMap.has(oldNode.id)) diff.nodes.removed.push(oldNode.id);
});
...
function nodeChanged(oldNode, newNode): boolean {
    return oldNode.label !== newNode.label ||
           oldNode.type !== newNode.type ||
           oldNode.description !== newNode.description ||
           JSON.stringify(oldNode.source) !== JSON.stringify(newNode.source);
}
function edgeChanged(oldEdge, newEdge): boolean { return oldEdge.label !== newEdge.label; }
```

`hasDiff()` short-circuits no-op updates entirely (`graph-diff.ts:92-102`, used at `messages.ts:310-314`).

### 5.2 Three-tier re-render strategy

The single most reusable pattern in this repo (`messages.ts:357-424`). Layout always runs first off-DOM ("Run layout FIRST (calculates positions without touching DOM)", `messages.ts:357-358`), then:

```ts
// frontend/src/webview-client/messages.ts:360-424 (condensed)
const isAdditiveOnly = diff.nodes.removed.length === 0 && diff.edges.removed.length === 0;
const structureChanged = diff.nodes.added.length > 0 || diff.nodes.removed.length > 0 ||
                         diff.edges.added.length > 0 || diff.edges.removed.length > 0;

if (structureChanged && !isAdditiveOnly) {
    // TIER 1: removals present — crossfade old containers to fresh render
    const oldContainers = state.g.selectAll('.groups, .collapsed-groups, .nodes-container, .edge-paths-container, .edge-labels-container');
    renderGroups(); renderEdges(); renderNodes(...);   // appended AFTER old ones
    // start new containers at opacity 0, then:
    oldContainers.transition().duration(150).style('opacity', 0).remove();
    [newGroups, newNodes, newEdgePaths, newEdgeLabels].forEach(sel =>
        sel.transition().duration(150).style('opacity', 1));
} else if (isAdditiveOnly && structureChanged) {
    // TIER 2: additive-only — D3 enter/update/exit, "avoids the flickering"
    updateGroupsIncremental(); updateEdgesIncremental(); updateNodesIncremental(...);
} else {
    // TIER 3: no structure change — mutate bound datums in place, reposition, "no blink"
    state.g.select('.nodes-container').selectAll('.node').each(function(d) {
        const newData = state.currentGraphData.nodes.find(n => n.id === d.id);
        if (newData) Object.assign(d, newData);
    });
    /* same for .workflow-group and .link/.link-hover */
    formatGraph();   // re-applies transforms/paths from layout
}
```

The Tier-2 D3 join for nodes (`frontend/src/webview-client/nodes.ts:655-699`):

```ts
// frontend/src/webview-client/nodes.ts:670-696
const nodeSelection = nodesContainer.selectAll('.node')
    .data(expandedNodes, (d: any) => d.id);        // keyed join
nodeSelection.exit().remove();                      // EXIT
const enterNodes = nodeSelection.enter()            // ENTER
    .append('g').attr('class', 'node')
    .attr('data-node-id', (d: any) => d.id)
    .call(d3.drag().on('start', ...).on('drag', ...).on('end', ...));
enterNodes.each(function(d) { createNodeElement(d3.select(this), d); });
const allNodes = nodeSelection.merge(enterNodes);   // UPDATE+ENTER
allNodes.attr('transform', (d: any) => `translate(${d.x},${d.y})`);
```

`createNodeElement()` (`nodes.ts:502-653`) is the factory extracted from `renderNodes` so enter-nodes get identical internal structure. Edges do the same with composite key `${source}->${target}` (or a bidirectional key) at `edges.ts:570-721`, and edge labels at `edges.ts:753-826`. After any tier: `renderMinimap(); updateGroupVisibility(); ...; fadeInNodes(newNodeIds); pulseMinimapNodes(newNodeIds)` (`messages.ts:426-439`).

New nodes fade in (opacity 0→1 over 400ms, `nodes.ts:244-252`); minimap dots pulse r:2→4→2 twice (`minimap.ts:284-297`).

### 5.3 "Changed = highlight" implementation: CSS class + extension-side timer (no webview timeout)

`applyFileChangeState()` (`nodes.ts:399-482`) matches nodes by `node.source.file` + normalized `node.source.function` and toggles classes on the `.node-border` element directly (not via D3 data):

```ts
// frontend/src/webview-client/nodes.ts:449-465
allFileNodeIds.forEach(nodeId => {
    const border = document.querySelector(`.node[data-node-id="${escapedId}"] .node-border`);
    if (!border) return;
    border.classList.remove('file-active', 'file-changed');
    if (nodeIdsToHighlight.has(nodeId)) {
        if (changeState === 'active') border.classList.add('file-active');
        else if (changeState === 'changed') border.classList.add('file-changed');
    }
});
```

Semantics of the `functions` parameter (`nodes.ts:394-397`): `undefined` → highlight ALL file nodes (Phase 1 optimistic), `[]` → none, list → only those. The visual styling is pure CSS animation:

```css
/* frontend/media/webview/styles.css:1509-1538 */
/* Static green border - file has changed but not actively editing */
.node-border.file-changed {
    stroke: #00ff00 !important;
    stroke-width: 1px !important;
    transition: stroke 0.3s ease;
}
/* Animated neon chase border - file is being actively edited */
.node-border.file-active {
    stroke: #00ff00 !important;
    stroke-dasharray: 4 2;
    animation: neon-chase 0.5s linear infinite, neon-pulse 1.5s ease-in-out infinite;
    filter: drop-shadow(0 0 3px rgba(0, 255, 0, 0.6)) drop-shadow(0 0 6px rgba(0, 255, 0, 0.3));
}
@keyframes neon-chase { 0% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: -12; } }
```

The active→changed transition timer lives in the **extension** (4s `setTimeout` in `handler.ts:146-159`), not the webview. Crucially, because Tier-1/Tier-2 renders recreate DOM, the webview keeps an `activeFileChanges: Map<filePath, 'active'|'changed'>` and **re-applies all states after every render**: "(CSS classes are lost when DOM elements are recreated)" (`messages.ts:31-33, 453-457`). The same survival trick covers `pending` nodes (dashed border + italic while awaiting LLM labels — `nodes.ts:325-361`, `styles.css:1567-1581`), cleared when `hydrateLabels` arrives and labels fade-swap in place without re-render (`nodes.ts:260-281`, `messages.ts:238-279`).

## 6. Interactivity

**Node clicks via d3.drag, not `on('click')`.** Since dragging is disabled (ELK routes are static), the drag handlers double as click detection with a 5px movement threshold (`frontend/src/webview-client/drag.ts:20-40`):

```ts
// frontend/src/webview-client/drag.ts:20-39
export function dragended(event: any, d: any): void {
    const distance = Math.sqrt(Math.pow(event.x - dragStartX, 2) + Math.pow(event.y - dragStartY, 2));
    if (distance < 5) {
        event.sourceEvent?.stopPropagation();
        if (state.currentlyOpenNodeId === d.id) closePanel();
        else openPanel(d);
    }
}
```

Attached at node creation: `.call(d3.drag().on('start',...).on('drag',...).on('end',...))` (`nodes.ts:27-30`, `nodes.ts:684-687`). Clicking the SVG background / pegboard closes the panel (`main.ts:92-97`).

**Detail panel data flow** — the panel is static HTML (ids `sidePanel`, `panelTitle`, `panelType`, etc. in `frontend/media/webview/index.html`); `openPanel(nodeData)` (`frontend/src/webview-client/panel.ts:8-211`) writes the D3 datum into those elements: label → `title.textContent`, type → badge class `type-badge ${nodeData.type}` (`panel.ts:44-45`), description, then computes incoming/outgoing edges by filtering `currentGraphData.edges` (`panel.ts:92-190`) and renders clickable edge-item HTML with `data-source-id`/`data-target-id`/`data-node-id` attributes. `setupEdgeItemInteractions()` (`panel.ts:216-277`) wires hover → `highlightEdge(sourceId, targetId, true)` (which restyles the matching `.link` path, `edges.ts:727-751`) and click → `navigateToNode()` which animates `zoom.transform` to center the node then re-opens the panel (`panel.ts:282-312`). Panel opens via `panel.classList.add('open')` (`panel.ts:192`) and shows camera-corner selection indicators on the node (`panel.ts:209-210`).

**Click-to-source** — no URI scheme; a plain message:

```ts
// frontend/src/webview-client/panel.ts:58-65
(source as HTMLAnchorElement).onclick = (e: Event) => {
    e.preventDefault();
    vscode.postMessage({
        command: 'openFile',
        file: nodeData.source.file,
        line: nodeData.source.line
    });
};
```

Edge clicks fire the same `openFile` with `d.sourceLocation` (`edges.ts:285-294`). The extension handles it (`webview.ts:200-262`): resolves relative paths via `vscode.workspace.findFiles('**/'+path, '**/node_modules/**', 5)`, opens with `vscode.workspace.openTextDocument` + `vscode.window.showTextDocument` in a column other than the webview's, then sets selection and `editor.revealRange(range, vscode.TextEditorRevealType.InCenter)` (`webview.ts:254-259`). Edge hover shows a floating HTML tooltip with label/condition/payload, with an invisible wide `.link-hover` hit path (`EDGE_HOVER_HIT_WIDTH`) underneath for easy targeting (`edges.ts:256-294, 432-504`).

## 7. Theming

Pure pass-through of VS Code's injected CSS variables — **no theme-switching code at all**. VS Code injects `--vscode-*` custom properties on the webview root and updates them live on theme change; since every color is referenced via `var(...)` (in CSS and in inline SVG `style` attributes), dark/light switching is automatic. There is no `onDidChangeActiveColorTheme` listener and no `body.vscode-dark` selector anywhere (grep confirms zero hits in `frontend/`).

Mapping of variables to graph elements:
- SVG pegboard dots + arrowheads: `var(--vscode-editor-foreground)` (`setup.ts:32, 49, 113, 127`).
- Node fill: `var(--vscode-editor-background)`; node border: `var(--vscode-editorWidget-border)`; decision border: `var(--vscode-descriptionForeground)`; label text: `var(--vscode-editor-foreground)` (`nodes.ts:45, 55, 76, 95, 135, 175`). Hardcoded accents that intentionally bypass the theme: LLM nodes `#1976D2`, reference borders `#7c3aed`, workflow colors from `colorFromString()` HSL hashing (`nodes.ts:59, 76, 108`), and the green `#00ff00` change indicators (`styles.css:1510-1523`).
- Edge labels: bg `var(--vscode-editor-background)`, stroke `var(--vscode-editorWidget-border)`, text `var(--vscode-foreground)` (`edges.ts:395-410`).
- `styles.css` uses ~36 distinct variables; most frequent: `--vscode-foreground` (22 uses), `--vscode-panel-border` (19), `--vscode-editor-background` (18), `--vscode-descriptionForeground` (17), `--vscode-editor-foreground` (14), plus button/input/list/menu/progressBar tokens for chrome (counted via grep over `frontend/media/webview/styles.css`).
- The CSS file is read at panel-creation time and inlined into the HTML with `{{fontsUri}}` substitution (`frontend/src/webview.ts:627-641`).
- For PNG export (where CSS vars don't exist inside the serialized SVG), variables are resolved to concrete values via `getComputedStyle(document.documentElement).getPropertyValue(varName)` with hardcoded dark fallbacks (`frontend/src/webview-client/export.ts:25-40, 262-265`).

## 8. PNG export

`frontend/src/webview-client/export.ts` (1187 lines). Key design decision: they do **not** serialize the live SVG. `prepareSVGForExport()` (`export.ts:243-693`) **rebuilds a standalone SVG from scratch**, reading geometry from the DOM (`.link` path `d` attributes, node `transform`s, label rect sizes — `export.ts:321-337, 404-433`) and node data from state, while replacing every CSS variable with resolved concrete colors (`resolveCSSVariable`, `export.ts:32-40`) and replacing `<foreignObject>` HTML labels with native `<text>/<tspan>` (foreignObject does not rasterize via `drawImage`). Line breaks are recovered from the rendered DOM by walking character rects with `document.createRange()` to detect where the browser wrapped/hyphenated (`extractHyphenatedLines`, `export.ts:101-149`), with a canvas-`measureText` word-wrap fallback (`export.ts:155-213`). It appends a watermark badge (logo + workspace name) below the content (`export.ts:578-690`).

Serialization → raster (`svgToBase64`, `export.ts:708-774`):

```ts
// frontend/src/webview-client/export.ts:712-757 (condensed)
const svgString = new XMLSerializer().serializeToString(svg);
const base64Svg = btoa(unescape(encodeURIComponent(svgString)));
const svgDataUrl = `data:image/svg+xml;base64,${base64Svg}`;
...
const img = new Image();
img.crossOrigin = 'anonymous';
img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);     // scale = user-picked 0.3–2x
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.scale(scale, scale);
    if (format === 'jpeg') { ctx.fillStyle = bgColor; ctx.fillRect(0, 0, width, height); }
    ctx.drawImage(img, 0, 0, width, height);
    // Convert to data URL - more reliable than toBlob in webview contexts
    const dataUrl = canvas.toDataURL(mimeType, quality);
    const base64Data = dataUrl.split(',')[1];
    resolve(base64Data);
};
img.src = svgDataUrl;
```

So: base64 SVG data URL (not blob URL — comment at `export.ts:715` says base64 over URL-encoding; and `toDataURL` over `toBlob` for webview reliability, `export.ts:750`) → `Image` → canvas `drawImage` → `toDataURL` → strip prefix → `postMessage({command:'saveExport', data, suggestedName})` (`export.ts:779-786`). The extension shows `vscode.window.showSaveDialog`, remembers the last folder in `globalState`, and writes `Buffer.from(message.data, 'base64')` to disk (`frontend/src/webview.ts:302-342`). Export bounds come from node positions ± half-size + 40px padding, or a workflow group's bounds (`export.ts:45-85`). A resolution picker (200%→30%) disables options whose pixel dims exceed `MAX_CANVAS_DIM = 16384` (`export.ts:9-20, 910-926`); text auto-scales down for dense graphs (`calculateTextScale`, `export.ts:219-238`). Both per-workflow and whole-graph exports, PNG (transparent) and JPEG (bg-filled), exist (`export.ts:819-904`).

## 9. What to ignore (backend + graph-construction subsystems)

`backend/` is a FastAPI service whose sole job is **LLM semantic analysis with Gemini**: endpoints `POST /analyze` (code → workflow graph), `POST /analyze/metadata-only` (function names → human labels/descriptions), `POST /condense-structure`, and `GET /health` (`backend/main.py:31, 175, 245, 267`). It wraps `google.genai` with Gemini 2.5 Flash pricing constants (`backend/gemini_client.py:1-13`), builds prompts (`backend/prompts.py`), and parses Mermaid-formatted LLM output into the graph (`backend/mermaid_parser.py`). Note: tree-sitter parsing is NOT in the backend — it runs inside the extension (`frontend/src/tree-sitter/parser-manager.ts`, `extractors.ts`, per-language queries in `frontend/src/tree-sitter/queries/`, via `web-tree-sitter` + `tree-sitter-wasms`).

**Not relevant for an OTel-trace visualizer** (where graph structure arrives ready-made from spans): the entire `backend/` directory (entry `backend/main.py:31` — LLM inference to *discover* structure we already have); the frontend's LLM client and analysis pipeline (`frontend/src/api.ts`, `frontend/src/analyzer.ts`, `frontend/src/analysis/*` — entry `frontend/src/analysis/workspace.ts`); the tree-sitter call-graph extraction stack (`frontend/src/tree-sitter/parser-manager.ts`, `frontend/src/call-graph-extractor.ts`, `frontend/src/static-analyzer.ts`, `frontend/src/repo-structure.ts` — code parsing replaced by span ingestion); the metadata-hydration machinery (`frontend/src/metadata-batcher.ts`, `frontend/src/metadata-builder.ts` — span/resource attributes already carry names); cost tracking (`frontend/src/cost-tracking.ts`, `frontend/src/types.ts:117-149`); the file picker and cache (`frontend/src/file-picker.ts`, `frontend/src/webview-client/file-picker.ts`, `frontend/src/cache.ts`); and the file-watching trigger layer (`frontend/src/file-watching/handler.ts:47`) — though its **two-phase optimistic-then-refined highlight pattern and debounce/diff/patch shape map almost 1:1 onto SSE span batches**, so keep it as a design reference even while discarding the file-system specifics. What IS worth extracting wholesale: `webview-client/` rendering/layout/diff/interaction (`setup.ts`, `elk-layout.ts`, `layout.ts`, `nodes.ts`, `edges.ts`, `graph-diff.ts`, `messages.ts`, `panel.ts`, `minimap.ts`, `export.ts`, `state.ts`) and the message-queue-until-ready pattern in `webview.ts:41-100`.

---

## Caveats / deviations from the prompt's assumptions

- **No d3 ES import** — D3 is a vendored global script; `selectAll`-style code exists but all typed as `any` (`setup.ts:4`).
- **No port constraints** in ELK usage; flat (non-hierarchical) ELK graphs, one per workflow group, tiled by a custom packer rather than one big ELK run.
- **No node dragging** — explicitly disabled because ELK edge routes can't update incrementally (`drag.ts:1,17`). A drag-capable trace visualizer would need to re-run ELK or fall back to straight edges during drag.
- **The "green flash" is not a timeout-in-webview flash** — it's a persistent CSS state machine (`file-active` animated → `file-changed` static → removed), with the active→changed transition timed in the extension host and classes re-applied after every re-render.
- D3 transitions are used only for opacity crossfades/fades and zoom animation; positions in incremental updates are set instantly, not tweened.
