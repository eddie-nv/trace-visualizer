import type { ViewModel } from "../store/view-model.js";

export const COLUMN_WIDTH = 150;
export const COLUMN_GAP = 200;
export const HEADER_HEIGHT = 64;
export const ARROW_HEIGHT = 60;
export const ACTION_NODE_HEIGHT = 40;
export const SPAN_EVENT_HEIGHT = 16;
export const ROW_GAP = 10;

export interface ColumnLayout {
  readonly x: number;
  readonly width: number;
}

export interface RowLayout {
  readonly id: string;
  readonly kind: "arrow" | "actionNode" | "spanEvent";
  readonly y: number;
  readonly height: number;
  readonly timeNs: string;
}

export interface SwimlaneLayout {
  readonly columns: ReadonlyMap<string, ColumnLayout>;
  readonly rows: ReadonlyArray<RowLayout>;
  readonly totalHeight: number;
  readonly totalWidth: number;
  readonly COLUMN_GAP: number;
}

export function buildLayout(vm: ViewModel): SwimlaneLayout {
  const columns = new Map<string, ColumnLayout>();

  if (vm.participants.length === 0) {
    return {
      columns,
      rows: [],
      totalHeight: 0,
      totalWidth: 0,
      COLUMN_GAP,
    };
  }

  let nextX = COLUMN_GAP / 2 + COLUMN_WIDTH / 2;
  for (const p of vm.participants) {
    columns.set(p.id, { x: nextX, width: COLUMN_WIDTH });
    nextX += COLUMN_GAP;
  }

  const totalWidth = nextX - COLUMN_GAP / 2 + COLUMN_WIDTH / 2;

  type TimedItem =
    | { kind: "arrow"; id: string; timeNs: string }
    | { kind: "actionNode"; id: string; timeNs: string }
    | { kind: "spanEvent"; id: string; timeNs: string };

  const items: TimedItem[] = [
    ...vm.arrows.map((a) => ({ kind: "arrow" as const, id: a.id, timeNs: a.timeNs })),
    ...vm.actionNodes.map((n) => ({ kind: "actionNode" as const, id: n.id, timeNs: n.timeNs })),
    ...vm.spanEvents.map((e) => ({ kind: "spanEvent" as const, id: e.id, timeNs: e.timeNs })),
  ];

  items.sort((a, b) => compareNs(a.timeNs, b.timeNs));

  const rows: RowLayout[] = [];
  let yCursor = HEADER_HEIGHT + ROW_GAP;

  for (const item of items) {
    const height =
      item.kind === "arrow"
        ? ARROW_HEIGHT
        : item.kind === "actionNode"
          ? ACTION_NODE_HEIGHT
          : SPAN_EVENT_HEIGHT;

    rows.push({ id: item.id, kind: item.kind, y: yCursor, height, timeNs: item.timeNs });
    yCursor += height + ROW_GAP;
  }

  const totalHeight = rows.length > 0 ? yCursor : HEADER_HEIGHT;

  return { columns, rows, totalHeight, totalWidth, COLUMN_GAP };
}

function compareNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}
