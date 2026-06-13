import { describe, it, expect } from "vitest";
import { buildLayout, ARROW_HEIGHT, ACTION_NODE_HEIGHT, ROW_GAP, HEADER_HEIGHT } from "./swimlane.js";
import type { ViewModel } from "../store/view-model.js";

const BASE_VM: ViewModel = {
  participants: [
    { id: "A", label: "ServiceA", type: "service" },
    { id: "M", label: "model", type: "model" },
  ],
  arrows: [],
  actionNodes: [],
  spanEvents: [],
  fragments: [],
};

describe("buildLayout — column positions", () => {
  it("assigns x positions with fixed gap between participants", () => {
    const layout = buildLayout(BASE_VM);
    const colA = layout.columns.get("A");
    const colM = layout.columns.get("M");
    expect(colA).toBeDefined();
    expect(colM).toBeDefined();
    expect(colA!.x).toBeLessThan(colM!.x);
    // gap between centers should be COLUMN_GAP
    const { COLUMN_GAP } = layout;
    expect(colM!.x - colA!.x).toBe(COLUMN_GAP);
  });

  it("places first column at COLUMN_GAP / 2 from left", () => {
    const layout = buildLayout(BASE_VM);
    const colA = layout.columns.get("A");
    expect(colA!.x).toBeGreaterThan(0);
  });
});

describe("buildLayout — row y positions", () => {
  it("positions first arrow row below header", () => {
    const vm: ViewModel = {
      ...BASE_VM,
      arrows: [
        {
          id: "a1-req",
          fromParticipantId: "A",
          toParticipantId: "M",
          style: "solid",
          label: "req",
          timeNs: "1000",
          spanId: "a1",
        },
      ],
    };
    const layout = buildLayout(vm);
    const row = layout.rows.find((r) => r.id === "a1-req");
    expect(row).toBeDefined();
    expect(row!.y).toBe(HEADER_HEIGHT + ROW_GAP);
    expect(row!.height).toBe(ARROW_HEIGHT);
  });

  it("stacks rows consecutively with gap between them", () => {
    const vm: ViewModel = {
      ...BASE_VM,
      arrows: [
        {
          id: "a1-req",
          fromParticipantId: "A",
          toParticipantId: "M",
          style: "solid",
          label: "req1",
          timeNs: "1000",
          spanId: "a1",
        },
        {
          id: "a1-ret",
          fromParticipantId: "M",
          toParticipantId: "A",
          style: "dashed",
          label: "ret1",
          timeNs: "2000",
          spanId: "a1",
        },
      ],
    };
    const layout = buildLayout(vm);
    const row1 = layout.rows.find((r) => r.id === "a1-req")!;
    const row2 = layout.rows.find((r) => r.id === "a1-ret")!;
    expect(row2.y).toBe(row1.y + row1.height + ROW_GAP);
  });

  it("uses ACTION_NODE_HEIGHT for action node rows", () => {
    const vm: ViewModel = {
      ...BASE_VM,
      actionNodes: [
        {
          id: "node1",
          participantId: "A",
          label: "work",
          timeNs: "1000",
          spanId: "s1",
        },
      ],
    };
    const layout = buildLayout(vm);
    const row = layout.rows.find((r) => r.id === "node1");
    expect(row).toBeDefined();
    expect(row!.height).toBe(ACTION_NODE_HEIGHT);
  });

  it("interleaves arrows and span events in timestamp order", () => {
    const vm: ViewModel = {
      ...BASE_VM,
      arrows: [
        {
          id: "a1-req",
          fromParticipantId: "A",
          toParticipantId: "M",
          style: "solid",
          label: "req",
          timeNs: "1000",
          spanId: "a1",
        },
        {
          id: "a1-ret",
          fromParticipantId: "M",
          toParticipantId: "A",
          style: "dashed",
          label: "ret",
          timeNs: "3000",
          spanId: "a1",
        },
      ],
      spanEvents: [
        {
          id: "ev1",
          name: "ai.stream.firstChunk",
          timeNs: "2000",
          participantId: "M",
          spanId: "a1",
        },
      ],
    };
    const layout = buildLayout(vm);
    const rows = layout.rows.slice().sort((a, b) => a.y - b.y);
    expect(rows[0]?.id).toBe("a1-req");
    expect(rows[1]?.id).toBe("ev1");
    expect(rows[2]?.id).toBe("a1-ret");
  });
});

describe("buildLayout — total height", () => {
  it("returns 0 total content height for empty view model", () => {
    const layout = buildLayout({ ...BASE_VM, participants: [] });
    expect(layout.totalHeight).toBe(0);
  });

  it("totalHeight is at least HEADER_HEIGHT when there are participants", () => {
    const layout = buildLayout(BASE_VM);
    expect(layout.totalHeight).toBeGreaterThanOrEqual(HEADER_HEIGHT);
  });

  it("grows with each added row", () => {
    const vmWith1 = {
      ...BASE_VM,
      arrows: [
        {
          id: "a1-req",
          fromParticipantId: "A",
          toParticipantId: "M",
          style: "solid" as const,
          label: "req",
          timeNs: "1000",
          spanId: "a1",
        },
      ],
    };
    const vmWith2 = {
      ...vmWith1,
      arrows: [
        ...vmWith1.arrows,
        {
          id: "a1-ret",
          fromParticipantId: "M",
          toParticipantId: "A",
          style: "dashed" as const,
          label: "ret",
          timeNs: "2000",
          spanId: "a1",
        },
      ],
    };
    const layout1 = buildLayout(vmWith1);
    const layout2 = buildLayout(vmWith2);
    expect(layout2.totalHeight).toBeGreaterThan(layout1.totalHeight);
  });
});
