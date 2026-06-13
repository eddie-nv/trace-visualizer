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
  it("produces 3 participants in correct order", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.participants).toHaveLength(3);
    expect(vm.participants[0]?.id).toBe("ta-mqbcptif-1zdf");
    expect(vm.participants[0]?.type).toBe("service");
    expect(vm.participants[1]?.id).toBe("anthropic.messages:claude-mock-model");
    expect(vm.participants[1]?.type).toBe("model");
    expect(vm.participants[2]?.id).toBe("getWeather");
    expect(vm.participants[2]?.type).toBe("tool");
  });

  it("produces 6 arrows sorted by timestamp", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.arrows).toHaveLength(6);

    const [a1, a2, a3, a4, a5, a6] = vm.arrows;

    // doStream1 start → solid R→M
    expect(a1?.style).toBe("solid");
    expect(a1?.fromParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a1?.toParticipantId).toBe("anthropic.messages:claude-mock-model");
    expect(a1?.timeNs).toBe("1781294439559000000");

    // toolCall start → solid R→T
    expect(a2?.style).toBe("solid");
    expect(a2?.fromParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a2?.toParticipantId).toBe("getWeather");
    expect(a2?.timeNs).toBe("1781294439668000000");

    // toolCall end → dashed T→R
    expect(a3?.style).toBe("dashed");
    expect(a3?.fromParticipantId).toBe("getWeather");
    expect(a3?.toParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a3?.timeNs).toBe("1781294439668742000");

    // doStream1 end → dashed M→R
    expect(a4?.style).toBe("dashed");
    expect(a4?.fromParticipantId).toBe("anthropic.messages:claude-mock-model");
    expect(a4?.toParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a4?.timeNs).toBe("1781294439706544000");

    // doStream2 start → solid R→M
    expect(a5?.style).toBe("solid");
    expect(a5?.fromParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a5?.toParticipantId).toBe("anthropic.messages:claude-mock-model");
    expect(a5?.timeNs).toBe("1781294439710000000");

    // doStream2 end → dashed M→R
    expect(a6?.style).toBe("dashed");
    expect(a6?.fromParticipantId).toBe("anthropic.messages:claude-mock-model");
    expect(a6?.toParticipantId).toBe("ta-mqbcptif-1zdf");
    expect(a6?.timeNs).toBe("1781294439763987000");
  });

  it("produces 1 ActionNode for the root span", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.actionNodes).toHaveLength(1);
    expect(vm.actionNodes[0]?.spanId).toBe("12b794a2e9552885");
    expect(vm.actionNodes[0]?.participantId).toBe("ta-mqbcptif-1zdf");
  });

  it("produces 4 span events on the model participant", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    expect(vm.spanEvents).toHaveLength(4);
    expect(vm.spanEvents.every((e) => e.participantId === "anthropic.messages:claude-mock-model")).toBe(true);
    expect(vm.spanEvents.map((e) => e.name)).toEqual([
      "ai.stream.firstChunk",
      "ai.stream.finish",
      "ai.stream.firstChunk",
      "ai.stream.finish",
    ]);
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

  it("uses gen_ai.provider.name over gen_ai.system for model participant id", () => {
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
    const modelParticipant = vm.participants.find((p) => p.type === "model");
    expect(modelParticipant?.id).toBe("openai:gpt-4o");
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

  it("does not create duplicate participants for repeated model spans", () => {
    const vm = spansToViewModel(ALL_ENTRIES);
    const modelParticipants = vm.participants.filter((p) => p.type === "model");
    expect(modelParticipants).toHaveLength(1);
  });
});
