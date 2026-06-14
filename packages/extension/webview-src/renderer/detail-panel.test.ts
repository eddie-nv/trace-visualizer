// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import type { InferredActionNode, InferredArrow } from "../store/view-model.js";
import { hideDetail, initDetailPanel, showInferredDetail, showSpanDetail } from "./detail-panel.js";

function makeInferredNode(overrides: Partial<InferredActionNode> = {}): InferredActionNode {
  return {
    kind: "inferred",
    id: "n1",
    participantId: "agent-a",
    label: "parsed tool_use block",
    timeNs: "1000000000",
    codePointer: { file: "/src/agent.ts", line: 42 },
    reasoning: "Model decided to call web_search tool",
    ...overrides,
  };
}

function makeSpan(overrides: Partial<OtlpSpan> = {}): OtlpSpan {
  return {
    traceId: "t1",
    spanId: "s1",
    name: "test-span",
    startTimeUnixNano: "1000000000",
    endTimeUnixNano: "2000000000",
    attributes: [],
    ...overrides,
  };
}

describe("detail-panel", () => {
  let container: HTMLDivElement;
  let onOpenFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Re-create a fresh container and re-initialise the module-level panel
    // singleton before each test so tests are fully isolated.
    container = document.createElement("div");
    document.body.appendChild(container);
    onOpenFile = vi.fn();
    initDetailPanel(container, onOpenFile);
  });

  afterEach(() => {
    // Remove the container so the next beforeEach starts with a clean body.
    container.remove();
  });

  describe("showSpanDetail — span with code.* attributes", () => {
    it("makes the panel visible, renders #ag-open-file-btn with correct data attributes, and calls onOpenFile on click", () => {
      // Arrange
      const span = makeSpan({
        attributes: [
          { key: "code.file.path", value: { stringValue: "/src/agent.ts" } },
          { key: "code.line.number", value: { intValue: 42 } },
          { key: "code.function.name", value: { stringValue: "runLoop" } },
        ],
      });

      // Act
      showSpanDetail(span);

      // Assert — panel is visible
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel).not.toBeNull();
      expect(panel!.style.display).not.toBe("none");

      // Assert — button exists with correct data attributes
      const btn = panel!.querySelector<HTMLButtonElement>("#ag-open-file-btn");
      expect(btn).not.toBeNull();
      expect(btn!.dataset["file"]).toBe("/src/agent.ts");
      expect(btn!.dataset["line"]).toBe("42");
      expect(btn!.dataset["fn"]).toBe("runLoop");

      // Assert — clicking the button calls the callback with (file, line, fn)
      btn!.click();
      expect(onOpenFile).toHaveBeenCalledOnce();
      expect(onOpenFile).toHaveBeenCalledWith("/src/agent.ts", 42, "runLoop");
    });
  });

  describe("showSpanDetail — span with NO code.* attributes", () => {
    it("does not render #ag-open-file-btn", () => {
      // Arrange
      const span = makeSpan({ attributes: [] });

      // Act
      showSpanDetail(span);

      // Assert
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel).not.toBeNull();
      const btn = panel!.querySelector("#ag-open-file-btn");
      expect(btn).toBeNull();
    });
  });

  describe("close button", () => {
    it("hides the panel when the × button is clicked", () => {
      // Arrange
      const span = makeSpan({ attributes: [] });
      showSpanDetail(span);
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel!.style.display).not.toBe("none");

      // Act
      const closeBtn = panel!.querySelector<HTMLButtonElement>("#ag-panel-close");
      expect(closeBtn).not.toBeNull();
      closeBtn!.click();

      // Assert
      expect(panel!.style.display).toBe("none");
    });
  });

  describe("showInferredDetail — inferred node", () => {
    it("makes the panel visible and renders the node label in a colored header", () => {
      // Arrange
      const node = makeInferredNode({ label: "parsed tool_use block" });

      // Act
      showInferredDetail(node, "hsl(120, 65%, 35%)");

      // Assert — panel is visible
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel).not.toBeNull();
      expect(panel!.style.display).not.toBe("none");

      // Assert — label text present
      expect(panel!.textContent).toContain("parsed tool_use block");

      // Assert — colored header present (jsdom normalises hsl→rgb so check innerHTML)
      const header = panel!.querySelector<HTMLElement>("#ag-inferred-header");
      expect(header).not.toBeNull();
      expect(panel!.innerHTML).toContain("hsl(120, 65%, 35%)");
    });

    it("renders the reasoning text", () => {
      // Arrange
      const node = makeInferredNode({ reasoning: "Model decided to call web_search tool" });

      // Act
      showInferredDetail(node, "hsl(200, 65%, 35%)");

      // Assert
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel!.textContent).toContain("Model decided to call web_search tool");
    });

    it("renders Open in editor button that calls onOpenFile with file and line", () => {
      // Arrange
      const node = makeInferredNode({
        codePointer: { file: "/src/agent.ts", line: 42 },
      });

      // Act
      showInferredDetail(node, "hsl(120, 65%, 35%)");

      // Assert — button has correct data attributes
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      const btn = panel!.querySelector<HTMLButtonElement>("#ag-open-file-btn");
      expect(btn).not.toBeNull();
      expect(btn!.dataset["file"]).toBe("/src/agent.ts");
      expect(btn!.dataset["line"]).toBe("42");

      // Assert — clicking calls onOpenFile
      btn!.click();
      expect(onOpenFile).toHaveBeenCalledOnce();
      expect(onOpenFile).toHaveBeenCalledWith("/src/agent.ts", 42, undefined);
    });

    it("renders code snippet in a pre block when codePointer.snippet is provided", () => {
      // Arrange
      const node = makeInferredNode({
        codePointer: { file: "/src/agent.ts", line: 42, snippet: "const x = callTool();" },
      });

      // Act
      showInferredDetail(node, "hsl(120, 65%, 35%)");

      // Assert
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      const pre = panel!.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain("const x = callTool();");
    });

    it("does not render a pre block when snippet is absent", () => {
      // Arrange
      const node = makeInferredNode({
        codePointer: { file: "/src/agent.ts", line: 42 },
      });

      // Act
      showInferredDetail(node, "hsl(120, 65%, 35%)");

      // Assert
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel!.querySelector("pre")).toBeNull();
    });

    it("close button hides the panel", () => {
      // Arrange
      const node = makeInferredNode({});
      showInferredDetail(node, "hsl(120, 65%, 35%)");
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel!.style.display).not.toBe("none");

      // Act
      panel!.querySelector<HTMLButtonElement>("#ag-panel-close")!.click();

      // Assert
      expect(panel!.style.display).toBe("none");
    });

    it("also works with InferredArrow shape", () => {
      // Arrange
      const arrow: InferredArrow = {
        kind: "inferred",
        id: "a1",
        fromParticipantId: "agent-a",
        toParticipantId: "tool-search",
        style: "dashed",
        label: "invoke web_search",
        timeNs: "1000000000",
        codePointer: { file: "/src/tool.ts", line: 10 },
        reasoning: "LLM emitted a tool_use block",
      };

      // Act
      showInferredDetail(arrow, "hsl(240, 65%, 35%)");

      // Assert
      const panel = container.querySelector<HTMLDivElement>("#ag-detail-panel");
      expect(panel!.textContent).toContain("invoke web_search");
      expect(panel!.textContent).toContain("LLM emitted a tool_use block");
    });
  });
});
