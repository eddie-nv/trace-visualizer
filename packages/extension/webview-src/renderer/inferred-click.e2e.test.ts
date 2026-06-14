// @vitest-environment jsdom
/**
 * E2E webview integration tests — inferred-node click interaction.
 *
 * These tests exercise the full renderer → DOM click → detail-panel pipeline
 * entirely within a jsdom environment. This is the established E2E harness for
 * this webview layer: the webview only runs inside VS Code so there is no
 * standalone HTTP server to point a browser at. The vitest.config.ts coverage
 * comment confirms: "Browser webview entry point and DOM renderers — require
 * DOM; covered by E2E."
 *
 * The test structure mirrors app.ts:
 *   renderActionNodes / renderArrows supply inferred-selected callbacks that
 *   call showInferredDetail — exactly as app.ts wires them. Tests then assert
 *   on the resulting #ag-detail-panel DOM state.
 *
 * Coverage:
 *   1. Observed span click → B&W detail panel, no #ag-inferred-header
 *   2. Observed span click → no #ag-open-file-btn when span has no code.* attrs
 *   3. Inferred node click → colored #ag-inferred-header, label, reasoning
 *   4. Inferred node click → #ag-open-file-btn with correct data-file / data-line
 *   5. Inferred node click → Open-in-editor button calls onOpenFile callback
 *   6. Inferred arrow click → colored header, reasoning, Open-in-editor button
 *   7. #ag-panel-close hides the panel
 *   8. Code snippet → <pre> block rendered
 *   9. No snippet → no <pre> block
 *  10. Code badge (.ag-code-badge) fires onCodePointerClick and stops propagation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InferredActionNode, InferredArrow, ObservedActionNode } from "../store/view-model.js";
import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import type { ColumnLayout, RowLayout } from "../layout/swimlane.js";
import { renderActionNodes, clearActionNodes } from "./action-nodes.js";
import { renderArrows, clearArrows } from "./arrows.js";
import {
  initDetailPanel,
  showSpanDetail,
  showInferredDetail,
} from "./detail-panel.js";
import { colorFromString } from "./color.js";

// ── SVG scaffold ──────────────────────────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";

interface SvgScaffold {
  readonly svg: SVGSVGElement;
  readonly nodesG: SVGGElement;
  readonly arrowsG: SVGGElement;
}

function makeSvgScaffold(): SvgScaffold {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  // <defs> is required by ensureInferredMarker inside arrows.ts
  svg.appendChild(document.createElementNS(SVG_NS, "defs"));
  const nodesG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  const arrowsG = document.createElementNS(SVG_NS, "g") as SVGGElement;
  svg.appendChild(nodesG);
  svg.appendChild(arrowsG);
  return { svg, nodesG, arrowsG };
}

// ── Layout constants ──────────────────────────────────────────────────────────

const PARTICIPANT_A = "agent-a";
const PARTICIPANT_B = "tool-search";

const COLUMNS: ReadonlyMap<string, ColumnLayout> = new Map([
  [PARTICIPANT_A, { x: 200, width: 150 }],
  [PARTICIPANT_B, { x: 400, width: 150 }],
]);

function makeRowMap(id: string, kind: "actionNode" | "arrow" = "actionNode"): ReadonlyMap<string, RowLayout> {
  return new Map([[id, { id, kind, y: 100, height: 40, timeNs: "1000000000" }]]);
}

// ── Fixture factories ─────────────────────────────────────────────────────────

function makeInferredNode(overrides: Partial<InferredActionNode> = {}): InferredActionNode {
  return {
    kind: "inferred",
    id: "n1",
    participantId: PARTICIPANT_A,
    label: "parsed tool_use block",
    timeNs: "1000000000",
    codePointer: { file: "/src/agent.ts", line: 42 },
    reasoning: "Model decided to call web_search tool",
    ...overrides,
  };
}

function makeObservedNode(overrides: Partial<ObservedActionNode> = {}): ObservedActionNode {
  return {
    kind: "observed",
    id: "n2",
    participantId: PARTICIPANT_A,
    label: "chat claude",
    timeNs: "2000000000",
    spanId: "span-1",
    ...overrides,
  };
}

function makeInferredArrow(overrides: Partial<InferredArrow> = {}): InferredArrow {
  return {
    kind: "inferred",
    id: "a1",
    fromParticipantId: PARTICIPANT_A,
    toParticipantId: PARTICIPANT_B,
    style: "dashed",
    label: "invoke web_search",
    timeNs: "1000000000",
    codePointer: { file: "/src/tool.ts", line: 10 },
    reasoning: "LLM emitted a tool_use block",
    ...overrides,
  };
}

function makeSpan(overrides: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    traceId: "t1",
    spanId: "span-1",
    name: "chat claude-opus",
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: [],
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the accent color that app.ts uses for an inferred node. */
function accentFor(participantId: string): string {
  return colorFromString(participantId, 65, 35);
}

function getPanel(container: HTMLElement): HTMLDivElement {
  const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
  if (panel === null) throw new Error("#ag-detail-panel not found in container");
  return panel;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("inferred-node click interaction — webview E2E", () => {
  let container: HTMLDivElement;
  let onOpenFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onOpenFile = vi.fn();
    initDetailPanel(container, onOpenFile);
  });

  afterEach(() => {
    container.remove();
    // Reset renderer-internal caches so the next test gets a fresh slate
    clearActionNodes();
    clearArrows();
  });

  // ── 1 & 2. Observed span click ────────────────────────────────────────────

  describe("observed span click", () => {
    it("makes #ag-detail-panel visible, shows span name, no #ag-inferred-header", () => {
      // Arrange
      const span = makeSpan({ name: "chat claude-opus" });
      const spanIndex = new Map<string, OtlpSpan>([["span-1", span]]);
      const node = makeObservedNode({ spanId: "span-1" });
      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        (spanId) => showSpanDetail(spanIndex.get(spanId)),
      );

      // Act
      const nodeEl = nodesG.querySelector<SVGGElement>('[data-span-id="span-1"]');
      expect(nodeEl).not.toBeNull();
      nodeEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert
      const panel = getPanel(container);
      expect(panel.style.display).not.toBe("none");
      expect(panel.textContent).toContain("chat claude-opus");
      expect(panel.querySelector("#ag-inferred-header")).toBeNull();
    });

    it("does not render #ag-open-file-btn when span has no code.* attributes", () => {
      // Arrange
      const span = makeSpan({ attributes: [] });
      const spanIndex = new Map<string, OtlpSpan>([["span-1", span]]);
      const node = makeObservedNode({ spanId: "span-1" });
      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        (spanId) => showSpanDetail(spanIndex.get(spanId)),
      );

      // Act
      nodesG.querySelector<SVGGElement>('[data-span-id="span-1"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert
      expect(getPanel(container).querySelector("#ag-open-file-btn")).toBeNull();
    });
  });

  // ── 3. Inferred node click — colored header and reasoning ─────────────────

  describe("inferred node click — colored header and reasoning", () => {
    it("shows #ag-detail-panel with colored #ag-inferred-header, label, and reasoning", () => {
      // Arrange
      const node = makeInferredNode({ label: "parsed tool_use block" });
      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        vi.fn(),
        undefined,
        (clicked) => showInferredDetail(clicked, accentFor(clicked.participantId)),
      );

      // Act
      const nodeEl = nodesG.querySelector<SVGGElement>(".ag-action-node-inferred");
      expect(nodeEl).not.toBeNull();
      nodeEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert — panel visible
      const panel = getPanel(container);
      expect(panel.style.display).not.toBe("none");

      // Assert — colored header exists and carries the accent color
      const header = panel.querySelector<HTMLElement>("#ag-inferred-header");
      expect(header).not.toBeNull();
      expect(panel.innerHTML).toContain(accentFor(PARTICIPANT_A));

      // Assert — label and reasoning present
      expect(panel.textContent).toContain("parsed tool_use block");
      expect(panel.textContent).toContain("Model decided to call web_search tool");
    });
  });

  // ── 4 & 5. Inferred node click — Open-in-editor button ───────────────────

  describe("inferred node click — Open-in-editor button", () => {
    it("renders #ag-open-file-btn with correct data-file and data-line", () => {
      // Arrange
      const node = makeInferredNode({ codePointer: { file: "/src/agent.ts", line: 42 } });
      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        vi.fn(),
        undefined,
        (clicked) => showInferredDetail(clicked, accentFor(clicked.participantId)),
      );

      // Act
      nodesG.querySelector<SVGGElement>(".ag-action-node-inferred")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert
      const btn = getPanel(container).querySelector<HTMLButtonElement>("#ag-open-file-btn");
      expect(btn).not.toBeNull();
      expect(btn!.dataset["file"]).toBe("/src/agent.ts");
      expect(btn!.dataset["line"]).toBe("42");
    });

    it("calls onOpenFile(file, line) when Open-in-editor button is clicked", () => {
      // Arrange
      const node = makeInferredNode({ codePointer: { file: "/src/agent.ts", line: 42 } });
      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        vi.fn(),
        undefined,
        (clicked) => showInferredDetail(clicked, accentFor(clicked.participantId)),
      );

      nodesG.querySelector<SVGGElement>(".ag-action-node-inferred")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Act
      getPanel(container).querySelector<HTMLButtonElement>("#ag-open-file-btn")!.click();

      // Assert
      expect(onOpenFile).toHaveBeenCalledOnce();
      expect(onOpenFile).toHaveBeenCalledWith("/src/agent.ts", 42, undefined);
    });
  });

  // ── 6. Inferred arrow click ───────────────────────────────────────────────

  describe("inferred arrow click", () => {
    it("shows colored #ag-inferred-header, reasoning text, and Open-in-editor button", () => {
      // Arrange
      const arrow = makeInferredArrow({
        reasoning: "LLM emitted a tool_use block",
        codePointer: { file: "/src/tool.ts", line: 10 },
      });
      const { svg, arrowsG } = makeSvgScaffold();
      container.appendChild(svg);

      renderArrows(
        arrowsG,
        [arrow],
        COLUMNS,
        makeRowMap(arrow.id, "arrow"),
        vi.fn(),
        (clicked) => showInferredDetail(clicked, accentFor(clicked.fromParticipantId)),
      );

      // Act
      const arrowEl = arrowsG.querySelector<SVGGElement>(".ag-arrow-inferred");
      expect(arrowEl).not.toBeNull();
      arrowEl!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert — panel visible with inferred header
      const panel = getPanel(container);
      expect(panel.style.display).not.toBe("none");
      expect(panel.querySelector("#ag-inferred-header")).not.toBeNull();
      expect(panel.innerHTML).toContain(accentFor(PARTICIPANT_A));

      // Assert — content
      expect(panel.textContent).toContain("invoke web_search");
      expect(panel.textContent).toContain("LLM emitted a tool_use block");

      // Assert — Open-in-editor button
      const btn = panel.querySelector<HTMLButtonElement>("#ag-open-file-btn");
      expect(btn).not.toBeNull();
      expect(btn!.dataset["file"]).toBe("/src/tool.ts");
      expect(btn!.dataset["line"]).toBe("10");
    });

    it("calls onOpenFile when Open-in-editor button is clicked after arrow click", () => {
      // Arrange
      const arrow = makeInferredArrow({ codePointer: { file: "/src/tool.ts", line: 10 } });
      const { svg, arrowsG } = makeSvgScaffold();
      container.appendChild(svg);

      renderArrows(
        arrowsG,
        [arrow],
        COLUMNS,
        makeRowMap(arrow.id, "arrow"),
        vi.fn(),
        (clicked) => showInferredDetail(clicked, accentFor(clicked.fromParticipantId)),
      );

      arrowsG.querySelector<SVGGElement>(".ag-arrow-inferred")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Act
      getPanel(container).querySelector<HTMLButtonElement>("#ag-open-file-btn")!.click();

      // Assert
      expect(onOpenFile).toHaveBeenCalledOnce();
      expect(onOpenFile).toHaveBeenCalledWith("/src/tool.ts", 10, undefined);
    });
  });

  // ── 7. Close button (#ag-panel-close) ────────────────────────────────────

  describe("close button (#ag-panel-close)", () => {
    it("hides the panel when × is clicked after an observed span opens it", () => {
      // Arrange
      showSpanDetail(makeSpan());
      const panel = getPanel(container);
      expect(panel.style.display).not.toBe("none");

      // Act
      const closeBtn = panel.querySelector<HTMLButtonElement>("#ag-panel-close");
      expect(closeBtn).not.toBeNull();
      closeBtn!.click();

      // Assert
      expect(panel.style.display).toBe("none");
    });

    it("hides the panel when × is clicked after an inferred node opens it", () => {
      // Arrange
      const node = makeInferredNode({});
      showInferredDetail(node, accentFor(node.participantId));
      const panel = getPanel(container);
      expect(panel.style.display).not.toBe("none");

      // Act
      panel.querySelector<HTMLButtonElement>("#ag-panel-close")!.click();

      // Assert
      expect(panel.style.display).toBe("none");
    });
  });

  // ── 8 & 9. Code snippet ───────────────────────────────────────────────────

  describe("code snippet section", () => {
    it("renders a <pre> block when codePointer.snippet is provided", () => {
      // Arrange
      const node = makeInferredNode({
        codePointer: { file: "/src/agent.ts", line: 42, snippet: "const x = callTool();" },
      });

      // Act
      showInferredDetail(node, accentFor(node.participantId));

      // Assert
      const pre = getPanel(container).querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain("const x = callTool();");
    });

    it("does not render a <pre> block when snippet is absent", () => {
      // Arrange
      const node = makeInferredNode({ codePointer: { file: "/src/agent.ts", line: 42 } });

      // Act
      showInferredDetail(node, accentFor(node.participantId));

      // Assert
      expect(getPanel(container).querySelector("pre")).toBeNull();
    });
  });

  // ── 10. Code badge (.ag-code-badge) stops propagation ────────────────────

  describe("code badge (.ag-code-badge) on inferred action node", () => {
    it("calls onCodePointerClick with file and line, and does NOT trigger the inferred-detail callback", () => {
      // Arrange
      const node = makeInferredNode({ codePointer: { file: "/src/agent.ts", line: 42 } });
      const onCodePointer = vi.fn();
      const onInferred = vi.fn();

      const { svg, nodesG } = makeSvgScaffold();
      container.appendChild(svg);

      renderActionNodes(
        nodesG,
        [node],
        COLUMNS,
        makeRowMap(node.id),
        vi.fn(),
        onCodePointer,
        onInferred,
      );

      // Act — dispatch the click on the badge, not the outer <g>
      const badge = nodesG.querySelector<SVGGElement>(".ag-code-badge");
      expect(badge).not.toBeNull();
      badge!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      // Assert — badge callback fires with correct args
      expect(onCodePointer).toHaveBeenCalledOnce();
      expect(onCodePointer).toHaveBeenCalledWith("/src/agent.ts", 42);

      // Assert — stopPropagation prevents the outer click from triggering inferred-selected
      expect(onInferred).not.toHaveBeenCalled();
    });
  });
});
