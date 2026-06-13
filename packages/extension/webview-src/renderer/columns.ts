import type { Participant } from "../store/view-model.js";
import type { ColumnLayout } from "../layout/swimlane.js";
import { HEADER_HEIGHT, ROW_GAP } from "../layout/swimlane.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const HEADER_BOX_HEIGHT = 40;
const HEADER_BOX_PADDING_TOP = (HEADER_HEIGHT - HEADER_BOX_HEIGHT) / 2;

const columnElements = new Map<string, { header: SVGGElement; lifeline: SVGLineElement }>();

export function renderColumns(
  lifelinesG: SVGGElement,
  participants: ReadonlyArray<Participant>,
  columns: ReadonlyMap<string, ColumnLayout>,
  totalHeight: number,
): void {
  const lifelineBottom = Math.max(totalHeight, HEADER_HEIGHT + 40);

  for (const participant of participants) {
    const col = columns.get(participant.id);
    if (col === undefined) continue;

    if (columnElements.has(participant.id)) {
      const { lifeline } = columnElements.get(participant.id)!;
      lifeline.setAttribute("y2", String(lifelineBottom));
      continue;
    }

    const g = document.createElementNS(SVG_NS, "g") as SVGGElement;
    g.setAttribute("class", "ag-column");
    g.dataset["participantId"] = participant.id;

    const halfW = col.width / 2;
    const boxX = col.x - halfW;

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(boxX));
    rect.setAttribute("y", String(HEADER_BOX_PADDING_TOP));
    rect.setAttribute("width", String(col.width));
    rect.setAttribute("height", String(HEADER_BOX_HEIGHT));
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", "var(--tv-header-fill)");
    rect.setAttribute("stroke", "var(--tv-border)");
    rect.setAttribute("stroke-width", "1");

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(col.x));
    text.setAttribute("y", String(HEADER_BOX_PADDING_TOP + HEADER_BOX_HEIGHT / 2 + 5));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--tv-text)");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
    text.textContent = truncate(participant.label, 20);
    text.setAttribute("title", participant.label);

    const lifeline = document.createElementNS(SVG_NS, "line") as SVGLineElement;
    lifeline.setAttribute("x1", String(col.x));
    lifeline.setAttribute("y1", String(HEADER_HEIGHT));
    lifeline.setAttribute("x2", String(col.x));
    lifeline.setAttribute("y2", String(lifelineBottom));
    lifeline.setAttribute("stroke", "var(--tv-lifeline)");
    lifeline.setAttribute("stroke-width", "1");
    lifeline.setAttribute("stroke-dasharray", "4 4");

    g.appendChild(rect);
    g.appendChild(text);
    lifelinesG.appendChild(lifeline);
    lifelinesG.appendChild(g);

    columnElements.set(participant.id, { header: g, lifeline });
  }
}

/** Draw mirrored service-header boxes at the bottom of each lifeline on traceComplete. */
export function renderFooterColumns(
  lifelinesG: SVGGElement,
  participants: ReadonlyArray<Participant>,
  columns: ReadonlyMap<string, ColumnLayout>,
  totalHeight: number,
): void {
  const footerY = totalHeight + ROW_GAP;
  const footerBottom =
    footerY + HEADER_BOX_PADDING_TOP + HEADER_BOX_HEIGHT + HEADER_BOX_PADDING_TOP;

  for (const participant of participants) {
    const col = columns.get(participant.id);
    const entry = columnElements.get(participant.id);
    if (!col || !entry) continue;

    // Extend lifeline to bottom of footer box.
    entry.lifeline.setAttribute("y2", String(footerBottom));

    const halfW = col.width / 2;
    const boxX = col.x - halfW;

    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(boxX));
    rect.setAttribute("y", String(footerY + HEADER_BOX_PADDING_TOP));
    rect.setAttribute("width", String(col.width));
    rect.setAttribute("height", String(HEADER_BOX_HEIGHT));
    rect.setAttribute("rx", "4");
    rect.setAttribute("fill", "var(--tv-header-fill)");
    rect.setAttribute("stroke", "var(--tv-border)");
    rect.setAttribute("stroke-width", "1");

    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", String(col.x));
    text.setAttribute("y", String(footerY + HEADER_BOX_PADDING_TOP + HEADER_BOX_HEIGHT / 2 + 5));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("fill", "var(--tv-text)");
    text.setAttribute("font-size", "12");
    text.setAttribute("font-family", "var(--vscode-font-family, monospace)");
    text.textContent = truncate(participant.label, 20);

    lifelinesG.appendChild(rect);
    lifelinesG.appendChild(text);
  }
}

export function clearColumns(): void {
  columnElements.clear();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
