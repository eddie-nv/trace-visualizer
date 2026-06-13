import type { Fragment } from "../store/view-model.js";
import type { ColumnLayout, RowLayout } from "../layout/swimlane.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const FRAGMENT_PADDING = 8;
const LABEL_HEIGHT = 18;

const fragmentElements = new Map<string, SVGGElement>();

export function renderFragments(
  fragmentsG: SVGGElement,
  fragments: ReadonlyArray<Fragment>,
  columns: ReadonlyMap<string, ColumnLayout>,
  rowMap: ReadonlyMap<string, RowLayout>,
): void {
  for (const fragment of fragments) {
    const memberRows = fragment.memberSpanIds
      .flatMap((spanId) => {
        const reqRow = rowMap.get(`${spanId}-req`);
        const retRow = rowMap.get(`${spanId}-ret`);
        return [reqRow, retRow].filter((r): r is RowLayout => r !== undefined);
      });

    if (memberRows.length === 0) continue;

    const minY = Math.min(...memberRows.map((r) => r.y)) - FRAGMENT_PADDING;
    const maxY = Math.max(...memberRows.map((r) => r.y + r.height)) + FRAGMENT_PADDING;

    const participantIds = fragment.memberSpanIds
      .flatMap((spanId) => {
        const reqId = `${spanId}-req`;
        // collect participant ids mentioned in arrows for this span
        return [];
      });

    const allX = [...columns.values()].map((c) => c.x);
    const minX = allX.length > 0 ? Math.min(...allX) - columns.values().next().value!.width / 2 - FRAGMENT_PADDING : 0;
    const maxX = allX.length > 0 ? Math.max(...allX) + columns.values().next().value!.width / 2 + FRAGMENT_PADDING : 100;

    if (fragmentElements.has(fragment.id)) {
      const g = fragmentElements.get(fragment.id)!;
      const rect = g.querySelector("rect");
      if (rect !== null) {
        rect.setAttribute("y", String(minY));
        rect.setAttribute("height", String(maxY - minY));
      }
      continue;
    }

    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("class", "ag-fragment");

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(minX));
    rect.setAttribute("y", String(minY));
    rect.setAttribute("width", String(maxX - minX));
    rect.setAttribute("height", String(maxY - minY));
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", "var(--tv-fragment-fill)");
    rect.setAttribute("stroke", "var(--tv-fragment-border)");
    rect.setAttribute("stroke-width", "1");
    rect.setAttribute("stroke-dasharray", "4 3");

    const labelBg = document.createElementNS(SVG_NS, "rect");
    labelBg.setAttribute("x", String(minX));
    labelBg.setAttribute("y", String(minY));
    labelBg.setAttribute("width", "60");
    labelBg.setAttribute("height", String(LABEL_HEIGHT));
    labelBg.setAttribute("rx", "2");
    labelBg.setAttribute("fill", "var(--tv-fragment-border)");

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(minX + 4));
    text.setAttribute("y", String(minY + LABEL_HEIGHT - 4));
    text.setAttribute("fill", "var(--tv-text)");
    text.setAttribute("font-size", "10");
    text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
    text.textContent = fragment.label;

    g.appendChild(rect);
    g.appendChild(labelBg);
    g.appendChild(text);
    fragmentsG.appendChild(g);
    fragmentElements.set(fragment.id, g);
  }
}

export function clearFragments(): void {
  fragmentElements.clear();
}
