import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LlmInferredNode } from "./types.js";

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

import { callLlm } from "./llm-client.js";

function makeResponse(nodes: LlmInferredNode[]) {
  return { content: [{ type: "text", text: JSON.stringify(nodes) }], stop_reason: "end_turn" };
}

const outputChannel = { appendLine: vi.fn() };

const validArrow: LlmInferredNode = {
  nodeType: "arrow",
  fromParticipantId: "svc-a",
  toParticipantId: "svc-b",
  style: "solid",
  label: "call",
  timeNs: "1000",
  codePointer: { file: "index.ts", line: 10 },
  reasoning: "makes sense",
};

const validAction: LlmInferredNode = {
  nodeType: "action",
  participantId: "svc-a",
  label: "process",
  timeNs: "2000",
  codePointer: { file: "agent.ts", line: 5 },
  reasoning: "does processing",
};

describe("callLlm", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    outputChannel.appendLine.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns parsed arrow nodes on success", async () => {
    mockCreate.mockResolvedValue(makeResponse([validArrow]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ nodeType: "arrow", fromParticipantId: "svc-a" });
  });

  it("returns parsed action nodes on success", async () => {
    mockCreate.mockResolvedValue(makeResponse([validAction]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ nodeType: "action", participantId: "svc-a" });
  });

  it("returns empty array when LLM returns empty array", async () => {
    mockCreate.mockResolvedValue(makeResponse([]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toEqual([]);
  });

  it("drops nodes where codePointer.file is an absolute path", async () => {
    const nodeWithAbsPath = { ...validArrow, codePointer: { file: "/etc/passwd", line: 1 } };
    mockCreate.mockResolvedValue(makeResponse([nodeWithAbsPath as LlmInferredNode]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toEqual([]);
    expect(outputChannel.appendLine).toHaveBeenCalledWith(expect.stringContaining("dropped"));
  });

  it("drops nodes where codePointer.file contains path traversal", async () => {
    const nodeWithTraversal = { ...validArrow, codePointer: { file: "../../etc/passwd", line: 1 } };
    mockCreate.mockResolvedValue(makeResponse([nodeWithTraversal as LlmInferredNode]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toEqual([]);
  });

  it("accepts nodes where codePointer.file is a relative path", async () => {
    const nodeWithRelPath = { ...validArrow, codePointer: { file: "src/agent.ts", line: 10 } };
    mockCreate.mockResolvedValue(makeResponse([nodeWithRelPath as LlmInferredNode]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toHaveLength(1);
  });

  it("returns null on parse failure without retrying", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "not json at all" }] });

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(outputChannel.appendLine).toHaveBeenCalled();
  });

  it("returns null when response is not a JSON array", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: '{"nodeType":"arrow"}' }],
    });

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toBeNull();
    expect(outputChannel.appendLine).toHaveBeenCalled();
  });

  it("drops invalid individual nodes and returns valid ones", async () => {
    const invalid = { nodeType: "arrow", fromParticipantId: "svc-a" }; // missing required fields
    mockCreate.mockResolvedValue(makeResponse([validArrow, invalid as LlmInferredNode]));

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ nodeType: "arrow", toParticipantId: "svc-b" });
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("dropped"),
    );
  });

  it("extracts JSON from markdown code block", async () => {
    const text = "```json\n" + JSON.stringify([validArrow]) + "\n```";
    mockCreate.mockResolvedValue({ content: [{ type: "text", text }] });

    const result = await callLlm("key", "prompt", outputChannel as never);

    expect(result).toHaveLength(1);
  });

  it("retries once on network error and returns nodes on retry", async () => {
    mockCreate
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(makeResponse([validAction]));

    const resultPromise = callLlm("key", "prompt", outputChannel as never);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("returns null after exhausting all retries", async () => {
    mockCreate.mockRejectedValue(new Error("network error"));

    const resultPromise = callLlm("key", "prompt", outputChannel as never);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBeNull();
    expect(mockCreate).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(outputChannel.appendLine).toHaveBeenCalled();
  });
});
