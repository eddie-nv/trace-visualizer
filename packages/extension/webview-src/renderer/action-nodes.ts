import type { ActionNode } from "../store/view-model.js";
import type { ColumnLayout, RowLayout } from "../layout/swimlane.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_WIDTH = 120;
const NODE_HEIGHT = 28;

const nodeElements = new Map<string, SVGGElement>();

type SpanSelectedCallback = (spanId: string) => void;

export function renderActionNodes(
  nodesG: SVGGElement,
  actionNodes: ReadonlyArray<ActionNode>,
  columns: ReadonlyMap<string, ColumnLayout>,
  rowMap: ReadonlyMap<string, RowLayout>,
  onSpanSelected: SpanSelectedCallback,
): void {
  for (const node of actionNodes) {
    if (nodeElements.has(node.id)) continue;

    const col = columns.get(node.participantId);
    const row = rowMap.get(node.id);
    if (col === undefined || row === undefined) continue;

    const cy = row.y + row.height / 2;
    const cx = col.x;
    const x = cx - NODE_WIDTH / 2;
    const y = cy - NODE_HEIGHT / 2;

    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("class", "ag-action-node");
    g.dataset["spanId"] = node.spanId;
    g.style.cursor = "pointer";

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(x));
    rect.setAttribute("y", String(y));
    rect.setAttribute("width", String(NODE_WIDTH));
    rect.setAttribute("height", String(NODE_HEIGHT));
    rect.setAttribute("rx", "3");
    rect.setAttribute("fill", "var(--tv-node-fill)");
    rect.setAttribute("stroke", "var(--tv-node-border)");
    rect.setAttribute("stroke-width", "1");

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(cx));
    text.setAttribute("y", String(cy + 4));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--tv-text)");
    text.setAttribute("font-size", "11");
    text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
    text.textContent = truncate(node.label, 18);

    g.appendChild(rect);
    g.appendChild(text);
    g.addEventListener("click", () => onSpanSelected(node.spanId));

    nodesG.appendChild(g);
    nodeElements.set(node.id, g);
  }
}

export function clearActionNodes(): void {
  nodeElements.clear();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
