// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import { hideDetail, initDetailPanel, showSpanDetail } from "./detail-panel.js";

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
});
