import type { Arrow, InferredArrow, SpanEvent } from "../store/view-model.js";
import type { ColumnLayout, RowLayout } from "../layout/swimlane.js";
import { colorFromString } from "./color.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const LABEL_OFFSET_Y = -6;
const HIT_AREA_WIDTH = 16;

const arrowElements = new Map<string, SVGGElement>();
const eventElements = new Map<string, SVGGElement>();

function ensureInferredMarker(svg: SVGSVGElement, participantId: string): string {
  const safeId = participantId.replace(/[^a-z0-9]/gi, "-");
  const markerId = `ag-arrow-inferred-${safeId}`;
  if (svg.querySelector(`#${markerId}`) !== null) return markerId;

  const defs = svg.querySelector("defs");
  if (defs === null) return "ag-arrow-inferred";

  const color = colorFromString(participantId, 70, 50);
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("markerWidth", "8");
  marker.setAttribute("markerHeight", "8");
  marker.setAttribute("refX", "6");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "strokeWidth");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M0,0 L0,6 L8,3 z");
  path.setAttribute("fill", color);
  marker.appendChild(path);
  defs.appendChild(marker);
  return markerId;
}

type SpanSelectedCallback = (spanId: string) => void;
type InferredSelectedCallback = (arrow: InferredArrow) => void;

export function renderArrows(
  arrowsG: SVGGElement,
  arrows: ReadonlyArray<Arrow>,
  columns: ReadonlyMap<string, ColumnLayout>,
  rowMap: ReadonlyMap<string, RowLayout>,
  onSpanSelected: SpanSelectedCallback,
  onInferredSelected?: InferredSelectedCallback,
): void {
  for (const arrow of arrows) {
    if (arrowElements.has(arrow.id)) continue;

    const fromCol = columns.get(arrow.fromParticipantId);
    const toCol = columns.get(arrow.toParticipantId);
    const row = rowMap.get(arrow.id);
    if (fromCol === undefined || toCol === undefined || row === undefined) continue;

    const y = row.y + row.height / 2;
    const x1 = fromCol.x;
    const x2 = toCol.x;

    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.dataset["arrowId"] = arrow.id;

    if (arrow.kind === "inferred") {
      const svg = arrowsG.ownerSVGElement;
      const color = colorFromString(arrow.fromParticipantId, 70, 50);
      const markerId = svg !== null ? ensureInferredMarker(svg, arrow.fromParticipantId) : "";
      g.setAttribute("class", "ag-arrow ag-arrow-inferred");
      g.style.opacity = "var(--tv-inferred-opacity, 0.85)";

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-width", "1.5");
      line.setAttribute("stroke-dasharray", "6 3");
      if (markerId) line.setAttribute("marker-end", `url(#${markerId})`);

      const hitLine = document.createElementNS(SVG_NS, "line");
      hitLine.setAttribute("x1", String(x1));
      hitLine.setAttribute("y1", String(y));
      hitLine.setAttribute("x2", String(x2));
      hitLine.setAttribute("y2", String(y));
      hitLine.setAttribute("stroke", "transparent");
      hitLine.setAttribute("stroke-width", String(HIT_AREA_WIDTH));

      const midX = (x1 + x2) / 2;
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(midX));
      text.setAttribute("y", String(y + LABEL_OFFSET_Y));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", color);
      text.setAttribute("font-size", "11");
      text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
      text.textContent = truncate(arrow.label, 40);

      g.appendChild(line);
      g.appendChild(hitLine);
      g.appendChild(text);

      g.style.cursor = "pointer";
      g.addEventListener("click", () => onInferredSelected?.(arrow));
    } else {
      const isDashed = arrow.style === "dashed";
      g.setAttribute("class", `ag-arrow ${isDashed ? "ag-arrow-dashed" : "ag-arrow-solid"}`);
      g.dataset["spanId"] = arrow.spanId;
      g.style.cursor = "pointer";

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y));
      line.setAttribute("stroke", isDashed ? "var(--tv-arrow-dashed)" : "var(--tv-arrow-solid)");
      line.setAttribute("stroke-width", "1.5");
      if (isDashed) {
        line.setAttribute("stroke-dasharray", "6 3");
        line.setAttribute("marker-end", "url(#ag-arrow-dashed)");
      } else {
        line.setAttribute("marker-end", "url(#ag-arrow-solid)");
      }

      const hitLine = document.createElementNS(SVG_NS, "line");
      hitLine.setAttribute("x1", String(x1));
      hitLine.setAttribute("y1", String(y));
      hitLine.setAttribute("x2", String(x2));
      hitLine.setAttribute("y2", String(y));
      hitLine.setAttribute("stroke", "transparent");
      hitLine.setAttribute("stroke-width", String(HIT_AREA_WIDTH));

      const midX = (x1 + x2) / 2;
      const text = document.createElementNS(SVG_NS, "text");
      text.setAttribute("x", String(midX));
      text.setAttribute("y", String(y + LABEL_OFFSET_Y));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("fill", isDashed ? "var(--tv-text-muted)" : "var(--tv-text)");
      text.setAttribute("font-size", "11");
      text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
      text.textContent = truncate(arrow.label, 40);

      g.appendChild(line);
      g.appendChild(hitLine);
      g.appendChild(text);

      g.addEventListener("click", () => onSpanSelected(arrow.spanId));
    }

    arrowsG.appendChild(g);
    arrowElements.set(arrow.id, g);
  }
}

export function renderSpanEvents(
  arrowsG: SVGGElement,
  spanEvents: ReadonlyArray<SpanEvent>,
  columns: ReadonlyMap<string, ColumnLayout>,
  rowMap: ReadonlyMap<string, RowLayout>,
): void {
  for (const event of spanEvents) {
    if (eventElements.has(event.id)) continue;

    const col = columns.get(event.participantId);
    const row = rowMap.get(event.id);
    if (col === undefined || row === undefined) continue;

    const y = row.y + row.height / 2;
    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("class", "ag-span-event");

    const diamond = document.createElementNS(SVG_NS, "polygon");
    const cx = col.x;
    const r = 5;
    diamond.setAttribute("points", `${cx},${y - r} ${cx + r},${y} ${cx},${y + r} ${cx - r},${y}`);
    diamond.setAttribute("fill", "var(--tv-accent)");

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("x", String(cx + r + 4));
    label.setAttribute("y", String(y + 4));
    label.setAttribute("fill", "var(--tv-text-muted)");
    label.setAttribute("font-size", "10");
    label.setAttribute("font-family", "var(--vscode-font-family, monospace)");
    label.textContent = event.name;

    g.appendChild(diamond);
    g.appendChild(label);
    arrowsG.appendChild(g);
    eventElements.set(event.id, g);
  }
}

export function clearArrows(): void {
  arrowElements.clear();
  eventElements.clear();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
