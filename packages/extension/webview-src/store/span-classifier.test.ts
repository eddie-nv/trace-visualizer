import { describe, it, expect } from "vitest";
import { spansToViewModel } from "./span-classifier.js";
import type { OtlpSpan } from "../../src/receiver/otlp-types.js";

const SERVICE = "ta-mqbcptif-1zdf";

const ROOT: OtlpSpan = {
  traceId: "14367ddf86ed1cf769c8d9f6433d0d58",
  spanId: "12b794a2e9552885",
  name: "ai.streamText",
  startTimeUnixNano: "1781294439547000000",
  endTimeUnixNano: "1781294439765936000",
  attributes: [
    { key: "ai.model.id", value: { stringValue: "claude-mock-model" } },
    { key: "ai.model.provider", value: { stringValue: "anthropic.messages" } },
  ],
};

const DOSTREAM1: OtlpSpan = {
  traceId: "14367ddf86ed1cf769c8d9f6433d0d58",
  spanId: "bbc3df22fb8b7e06",
  parentSpanId: "12b794a2e9552885",
  name: "ai.streamText.doStream",
  startTimeUnixNano: "1781294439559000000",
  endTimeUnixNano: "1781294439706544000",
  attributes: [
    { key: "gen_ai.request.model", value: { stringValue: "claude-mock-model" } },
    { key: "gen_ai.system", value: { stringValue: "anthropic.messages" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: 17 } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: 42 } },
    { key: "gen_ai.response.finish_reasons", value: { stringValue: '["tool-calls"]' } },
  ],
  events: [
    { name: "ai.stream.firstChunk", timeUnixNano: "1781294439663084000" },
    { name: "ai.stream.finish", timeUnixNano: "1781294439699714000" },
  ],
};

const DOSTREAM2: OtlpSpan = {
  traceId: "14367ddf86ed1cf769c8d9f6433d0d58",
  spanId: "968eba2eb0343703",
  parentSpanId: "12b794a2e9552885",
  name: "ai.streamText.doStream",
  startTimeUnixNano: "1781294439710000000",
  endTimeUnixNano: "1781294439763987000",
  attributes: [
    { key: "gen_ai.request.model", value: { stringValue: "claude-mock-model" } },
    { key: "gen_ai.system", value: { stringValue: "anthropic.messages" } },
    { key: "gen_ai.usage.input_tokens", value: { intValue: 17 } },
    { key: "gen_ai.usage.output_tokens", value: { intValue: 42 } },
    { key: "gen_ai.response.finish_reasons", value: { stringValue: '["stop"]' } },
    { key: "ai.response.text", value: { stringValue: "Hello from the deterministic mock." } },
  ],
  events: [
    { name: "ai.stream.firstChunk", timeUnixNano: "1781294439719247000" },
    { name: "ai.stream.finish", timeUnixNano: "1781294439763402000" },
  ],
};

const TOOL: OtlpSpan = {
  traceId: "14367ddf86ed1cf769c8d9f6433d0d58",
  spanId: "26876c60a74cf210",
  parentSpanId: "12b794a2e9552885",
  name: "ai.toolCall",
  startTimeUnixNano: "1781294439668000000",
  endTimeUnixNano: "1781294439668742000",
  attributes: [
    { key: "ai.toolCall.name", value: { stringValue: "getWeather" } },
    { key: "ai.toolCall.args", value: { stringValue: '{"city":"San Francisco"}' } },
    { key: "ai.toolCall.result", value: { stringValue: '{"temperature":17,"unit":"celsius"}' } },
  ],
};

const ALL_ENTRIES = [
  { span: ROOT, serviceName: SERVICE },
  { span: DOSTREAM1, serviceName: SERVICE },
  { span: DOSTREAM2, serviceName: SERVICE },
  { span: TOOL, serviceName: SERVICE },
];

describe("spansToViewModel — fixture A (Test D)", () => {
  it("produces 1 service participant — no model or tool participants for same-service spans", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.participants).toHaveLength(1);
    expect(vm.participants[0]?.id).toBe("ta-mqbcptif-1zdf");
    expect(vm.participants[0]?.type).toBe("service");
  });

  it("produces 0 arrows — all spans share the same service, no cross-service boundary", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.arrows).toHaveLength(0);
  });

  it("produces 4 action nodes — all spans become action nodes in the service column", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.actionNodes).toHaveLength(4);
    expect(vm.actionNodes.every((n) => n.participantId === "ta-mqbcptif-1zdf")).toBe(true);
    const spanIds = vm.actionNodes.map((n) => {
      if (n.kind !== "observed") throw new Error("expected observed");
      return n.spanId;
    });
    expect(spanIds).toContain("12b794a2e9552885"); // ROOT
    expect(spanIds).toContain("bbc3df22fb8b7e06"); // DOSTREAM1
    expect(spanIds).toContain("968eba2eb0343703"); // DOSTREAM2
    expect(spanIds).toContain("26876c60a74cf210"); // TOOL
  });

  it("produces 0 span events — no cross-service spans to emit events", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.spanEvents).toHaveLength(0);
  });

  it("produces 1 loop fragment grouping the 2 doStream spans", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.fragments).toHaveLength(1);
    const frag = vm.fragments[0];
    expect(frag?.label).toContain("loop");
    expect(frag?.memberSpanIds).toContain("bbc3df22fb8b7e06");
    expect(frag?.memberSpanIds).toContain("968eba2eb0343703");
  });
});

describe("spansToViewModel — participant classification", () => {
  it("classifies a span with agentgraph.agent.id as agent type", () => {
    const span: OtlpSpan = {
      traceId: "abc",
      spanId: "s1",
      name: "do.work",
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
      attributes: [{ key: "agentgraph.agent.id", value: { stringValue: "my-agent" } }],
    };
    const vm = spansToViewModel([{ span, serviceName: "svc" }]);
    expect(vm.participants[0]?.id).toBe("my-agent");
    expect(vm.participants[0]?.type).toBe("agent");
  });

  it("classifies a span with agentgraph.agent.fingerprint as cluster type", () => {
    const span: OtlpSpan = {
      traceId: "abc",
      spanId: "s1",
      name: "do.work",
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
      attributes: [{ key: "agentgraph.agent.fingerprint", value: { stringValue: "abc123" } }],
    };
    const vm = spansToViewModel([{ span, serviceName: "svc" }]);
    expect(vm.participants[0]?.id).toBe("abc123");
    expect(vm.participants[0]?.type).toBe("cluster");
  });

  it("falls back to service name when no other attributes present", () => {
    const span: OtlpSpan = {
      traceId: "abc",
      spanId: "s1",
      name: "do.work",
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
    };
    const vm = spansToViewModel([{ span, serviceName: "my-service" }]);
    expect(vm.participants[0]?.id).toBe("my-service");
    expect(vm.participants[0]?.type).toBe("service");
  });

  it("LLM span with gen_ai attributes becomes a service action node, not a model participant", () => {
    const span: OtlpSpan = {
      traceId: "abc",
      spanId: "s1",
      parentSpanId: "p1",
      name: "chat",
      startTimeUnixNano: "1000",
      endTimeUnixNano: "2000",
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
        { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
        { key: "gen_ai.system", value: { stringValue: "openai.chat" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: 20 } },
      ],
    };
    const parent: OtlpSpan = {
      traceId: "abc",
      spanId: "p1",
      name: "root",
      startTimeUnixNano: "500",
      endTimeUnixNano: "3000",
    };
    const vm = spansToViewModel([
      { span: parent, serviceName: "svc" },
      { span, serviceName: "svc" },
    ]);
    expect(vm.participants).toHaveLength(1);
    expect(vm.participants[0]?.type).toBe("service");
    expect(vm.participants.find((p) => p.type === "model")).toBeUndefined();
  });
});

describe("spansToViewModel — origin tagging", () => {
  it("stamps kind: observed on all arrows", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.arrows.every((a) => a.kind === "observed")).toBe(true);
  });

  it("stamps kind: observed on all action nodes", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.actionNodes.every((n) => n.kind === "observed")).toBe(true);
  });

  it("observed arrow carries spanId", () => {
    const parent: OtlpSpan = {
      traceId: "abc", spanId: "p1", name: "root",
      startTimeUnixNano: "1000", endTimeUnixNano: "5000",
    };
    const child: OtlpSpan = {
      traceId: "abc", spanId: "c1", parentSpanId: "p1", name: "worker",
      startTimeUnixNano: "1100", endTimeUnixNano: "4900",
    };
    const vm = spansToViewModel([
      { span: parent, serviceName: "svc-a" },
      { span: child, serviceName: "svc-b" },
    ]);
    const first = vm.arrows[0];
    expect(first?.kind).toBe("observed");
    if (first === undefined || first.kind !== "observed") throw new Error("expected observed arrow");
    expect(typeof first.spanId).toBe("string");
    expect(first.spanId.length).toBeGreaterThan(0);
  });

  it("observed action node carries spanId", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    const node = vm.actionNodes[0];
    expect(node?.kind).toBe("observed");
    if (node === undefined || node.kind !== "observed") throw new Error("expected observed action node");
    expect(node.spanId).toBe("12b794a2e9552885");
  });
});

describe("spansToViewModel — edge cases", () => {
  it("returns empty view model for empty input", () => {
    const vm = spansToViewModel([]);
    expect(vm.participants).toHaveLength(0);
    expect(vm.arrows).toHaveLength(0);
    expect(vm.actionNodes).toHaveLength(0);
    expect(vm.spanEvents).toHaveLength(0);
    expect(vm.fragments).toHaveLength(0);
  });

  it("does not create duplicate service participants for spans sharing the same serviceName", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    const serviceParticipants = vm.participants.filter((p) => p.type === "service");
    expect(serviceParticipants).toHaveLength(1);
  });
});

// ── Service-topology tests (RED — Phase 1) ────────────────────────────────────
// These tests assert the desired service-topology classifier behavior.
// They FAIL against the current implementation and must turn GREEN in Phase 2.

describe("spansToViewModel — service-topology: same-service LLM call", () => {
  // LLM span whose parent lives in the SAME service → action node only.
  // The old classifier promoted this to a model participant with arrows.
  const AGENT_ROOT: OtlpSpan = {
    traceId: "st1",
    spanId: "root",
    name: "agent.run",
    startTimeUnixNano: "1000",
    endTimeUnixNano: "5000",
  };
  const AGENT_LLM: OtlpSpan = {
    traceId: "st1",
    spanId: "llm1",
    parentSpanId: "root",
    name: "chat claude-opus-4-8",
    startTimeUnixNano: "2000",
    endTimeUnixNano: "4000",
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8" } },
      { key: "gen_ai.system", value: { stringValue: "anthropic.messages" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: 45 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 28 } },
    ],
  };
  const ENTRIES = [
    { span: AGENT_ROOT, serviceName: "agent-a" },
    { span: AGENT_LLM, serviceName: "agent-a" },
  ];

  it("produces 1 service participant — no separate model participant", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.participants).toHaveLength(1);
    expect(vm.participants[0]?.id).toBe("agent-a");
    expect(vm.participants[0]?.type).toBe("service");
  });

  it("produces 0 arrows — same-service LLM is an action node, not a cross-service call", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.arrows).toHaveLength(0);
  });

  it("produces 2 action nodes — root and LLM span both land in the service column", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.actionNodes).toHaveLength(2);
    expect(vm.actionNodes.every((n) => n.participantId === "agent-a")).toBe(true);
  });
});

describe("spansToViewModel — service-topology: cross-service parent boundary", () => {
  // Child span has a different serviceName than its parent → cross-service arrows
  // between the two service participants, plus action node in the target service.
  const ORCH_RUN: OtlpSpan = {
    traceId: "st2",
    spanId: "orch1",
    name: "orchestrator.run",
    startTimeUnixNano: "1000",
    endTimeUnixNano: "9000",
  };
  const AGENT_A_PROCESS: OtlpSpan = {
    traceId: "st2",
    spanId: "a1",
    parentSpanId: "orch1",
    name: "agent-a.process",
    startTimeUnixNano: "1100",
    endTimeUnixNano: "8900",
  };
  const ENTRIES = [
    { span: ORCH_RUN, serviceName: "orchestrator" },
    { span: AGENT_A_PROCESS, serviceName: "agent-a" },
  ];

  it("produces 2 service participants in first-appearance order", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.participants).toHaveLength(2);
    expect(vm.participants[0]?.id).toBe("orchestrator");
    expect(vm.participants[0]?.type).toBe("service");
    expect(vm.participants[1]?.id).toBe("agent-a");
    expect(vm.participants[1]?.type).toBe("service");
  });

  it("produces 2 arrows (solid request, dashed return) between the service participants", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.arrows).toHaveLength(2);

    const [req, ret] = vm.arrows;
    expect(req?.style).toBe("solid");
    expect(req?.fromParticipantId).toBe("orchestrator");
    expect(req?.toParticipantId).toBe("agent-a");
    expect(req?.timeNs).toBe("1100");

    expect(ret?.style).toBe("dashed");
    expect(ret?.fromParticipantId).toBe("agent-a");
    expect(ret?.toParticipantId).toBe("orchestrator");
    expect(ret?.timeNs).toBe("8900");
  });

  it("produces 2 action nodes — orchestrator.run in orchestrator, agent-a.process in agent-a", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.actionNodes).toHaveLength(2);

    const orchNode = vm.actionNodes.find((n) => n.participantId === "orchestrator");
    const agentNode = vm.actionNodes.find((n) => n.participantId === "agent-a");
    expect(orchNode).toBeDefined();
    expect(agentNode).toBeDefined();
    if (agentNode === undefined || agentNode.kind !== "observed") throw new Error("expected observed");
    expect(agentNode.spanId).toBe("a1");
  });
});

describe("spansToViewModel — service-topology: cross-service LLM span", () => {
  // LLM span emitted by a different service than its parent.
  // Service boundary, not LLM attributes, drives cross-service detection.
  // Arrow goes between service participants (not to a model participant).
  const ORCH_SPAN: OtlpSpan = {
    traceId: "st3",
    spanId: "orch1",
    name: "orchestrator.run",
    startTimeUnixNano: "1000",
    endTimeUnixNano: "9000",
  };
  const LLM_SPAN: OtlpSpan = {
    traceId: "st3",
    spanId: "llm1",
    parentSpanId: "orch1",
    name: "chat claude-opus-4-8",
    startTimeUnixNano: "2000",
    endTimeUnixNano: "4000",
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8" } },
      { key: "gen_ai.system", value: { stringValue: "anthropic.messages" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: 10 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 20 } },
    ],
  };
  const ENTRIES = [
    { span: ORCH_SPAN, serviceName: "orchestrator" },
    { span: LLM_SPAN, serviceName: "agent-a" },
  ];

  it("produces 2 service participants — no model participant even for LLM spans", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.participants).toHaveLength(2);
    expect(vm.participants.every((p) => p.type === "service")).toBe(true);
    expect(vm.participants[0]?.id).toBe("orchestrator");
    expect(vm.participants[1]?.id).toBe("agent-a");
  });

  it("produces 2 arrows between service participants, not to a model participant", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.arrows).toHaveLength(2);
    expect(vm.arrows[0]?.fromParticipantId).toBe("orchestrator");
    expect(vm.arrows[0]?.toParticipantId).toBe("agent-a");
    expect(vm.arrows[1]?.fromParticipantId).toBe("agent-a");
    expect(vm.arrows[1]?.toParticipantId).toBe("orchestrator");
  });

  it("produces 2 action nodes — orch.run in orchestrator, LLM span in agent-a", () => {
    const vm = spansToViewModel(ENTRIES);
    expect(vm.actionNodes).toHaveLength(2);
    const agentNode = vm.actionNodes.find((n) => n.participantId === "agent-a");
    expect(agentNode).toBeDefined();
    if (agentNode === undefined || agentNode.kind !== "observed") throw new Error("expected observed");
    expect(agentNode.spanId).toBe("llm1");
  });
});

describe("spansToViewModel — service-topology: multi-service demo trace", () => {
  // Full P0 demo span tree (6 spans across 3 services):
  //   orchestrator.run (orchestrator)
  //     └── agent-a.process (agent-a)        ← cross-service boundary
  //           ├── chat 1 (agent-a)            ← same-service action node
  //           │     └── agent-b.tool (agent-b) ← cross-service boundary
  //           │           └── web_search (agent-b) ← same-service action node
  //           └── chat 2 (agent-a)            ← same-service action node
  const ORCH_RUN: OtlpSpan = {
    traceId: "st4", spanId: "o1", name: "orchestrator.run",
    startTimeUnixNano: "1000", endTimeUnixNano: "9000",
  };
  const AGENT_A_PROCESS: OtlpSpan = {
    traceId: "st4", spanId: "a1", parentSpanId: "o1", name: "agent-a.process",
    startTimeUnixNano: "1100", endTimeUnixNano: "8900",
  };
  const CHAT_1: OtlpSpan = {
    traceId: "st4", spanId: "c1", parentSpanId: "a1", name: "chat",
    startTimeUnixNano: "1200", endTimeUnixNano: "4000",
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: 45 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 28 } },
    ],
  };
  const AGENT_B_TOOL: OtlpSpan = {
    traceId: "st4", spanId: "b1", parentSpanId: "c1", name: "agent-b.tool",
    startTimeUnixNano: "2000", endTimeUnixNano: "3500",
  };
  const WEB_SEARCH: OtlpSpan = {
    traceId: "st4", spanId: "w1", parentSpanId: "b1", name: "tool.web_search",
    startTimeUnixNano: "2100", endTimeUnixNano: "3400",
    attributes: [
      { key: "ai.toolCall.name", value: { stringValue: "web_search" } },
    ],
  };
  const CHAT_2: OtlpSpan = {
    traceId: "st4", spanId: "c2", parentSpanId: "a1", name: "chat",
    startTimeUnixNano: "4100", endTimeUnixNano: "6000",
    attributes: [
      { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8" } },
      { key: "gen_ai.usage.input_tokens", value: { intValue: 68 } },
      { key: "gen_ai.usage.output_tokens", value: { intValue: 32 } },
    ],
  };
  const DEMO_ENTRIES = [
    { span: ORCH_RUN, serviceName: "orchestrator" },
    { span: AGENT_A_PROCESS, serviceName: "agent-a" },
    { span: CHAT_1, serviceName: "agent-a" },
    { span: AGENT_B_TOOL, serviceName: "agent-b" },
    { span: WEB_SEARCH, serviceName: "agent-b" },
    { span: CHAT_2, serviceName: "agent-a" },
  ];

  it("produces 3 service participants in order: orchestrator, agent-a, agent-b", () => {
    const vm = spansToViewModel(DEMO_ENTRIES);
    expect(vm.participants).toHaveLength(3);
    expect(vm.participants[0]?.id).toBe("orchestrator");
    expect(vm.participants[0]?.type).toBe("service");
    expect(vm.participants[1]?.id).toBe("agent-a");
    expect(vm.participants[1]?.type).toBe("service");
    expect(vm.participants[2]?.id).toBe("agent-b");
    expect(vm.participants[2]?.type).toBe("service");
  });

  it("produces 4 arrows — one request+return pair per cross-service boundary", () => {
    const vm = spansToViewModel(DEMO_ENTRIES);
    expect(vm.arrows).toHaveLength(4);

    const orchToA = vm.arrows.find((a) => a.fromParticipantId === "orchestrator" && a.style === "solid");
    const aToOrch = vm.arrows.find((a) => a.toParticipantId === "orchestrator" && a.style === "dashed");
    const aToB = vm.arrows.find((a) => a.fromParticipantId === "agent-a" && a.style === "solid");
    const bToA = vm.arrows.find((a) => a.fromParticipantId === "agent-b" && a.style === "dashed");

    expect(orchToA).toBeDefined();
    expect(aToOrch).toBeDefined();
    expect(aToB).toBeDefined();
    expect(bToA).toBeDefined();
  });

  it("produces 6 action nodes — one per span distributed across service columns", () => {
    const vm = spansToViewModel(DEMO_ENTRIES);
    expect(vm.actionNodes).toHaveLength(6);

    const byService = (id: string) => vm.actionNodes.filter((n) => n.participantId === id);
    expect(byService("orchestrator")).toHaveLength(1); // orchestrator.run
    expect(byService("agent-a")).toHaveLength(3);      // agent-a.process, chat 1, chat 2
    expect(byService("agent-b")).toHaveLength(2);      // agent-b.tool, tool.web_search
  });

  it("produces 1 loop fragment grouping the 2 chat spans under agent-a.process", () => {
    const vm = spansToViewModel(DEMO_ENTRIES);
    expect(vm.fragments).toHaveLength(1);
    const frag = vm.fragments[0];
    expect(frag?.label).toContain("loop");
    expect(frag?.memberSpanIds).toContain("c1");
    expect(frag?.memberSpanIds).toContain("c2");
  });
});
