import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockIsEnrichmentEnabled, mockFindSourceFiles, mockBuildPrompt, mockCallLlm } =
  vi.hoisted(() => ({
    mockIsEnrichmentEnabled: vi.fn(),
    mockFindSourceFiles: vi.fn(),
    mockBuildPrompt: vi.fn(),
    mockCallLlm: vi.fn(),
  }));

vi.mock("./consent-gate.js", () => ({ isEnrichmentEnabled: mockIsEnrichmentEnabled }));
vi.mock("./source-finder.js", () => ({ findSourceFiles: mockFindSourceFiles }));
vi.mock("./prompt-builder.js", () => ({ buildPrompt: mockBuildPrompt }));
vi.mock("./llm-client.js", () => ({ callLlm: mockCallLlm }));

import { EnrichmentEngine } from "./index.js";
import type { TracedConversation } from "../receiver/span-store.js";

function makeConv(partial?: Partial<TracedConversation>): TracedConversation {
  return {
    traceId: "t1",
    spans: [],
    servicesSeen: new Set(["svc-a"]),
    complete: true,
    rootSpan: undefined,
    ...partial,
  };
}

function makeFanout() {
  return { broadcastInferredNodes: vi.fn() };
}

const outputChannel = { appendLine: vi.fn() };

const arrowNode = {
  nodeType: "arrow" as const,
  fromParticipantId: "svc-a",
  toParticipantId: "svc-b",
  style: "solid" as const,
  label: "call",
  timeNs: "1000",
  codePointer: { file: "index.ts", line: 1 },
  reasoning: "logic",
};

const actionNode = {
  nodeType: "action" as const,
  participantId: "svc-a",
  label: "process",
  timeNs: "2000",
  codePointer: { file: "agent.ts", line: 5 },
  reasoning: "does work",
};

describe("EnrichmentEngine", () => {
  let engine: EnrichmentEngine;

  beforeEach(() => {
    engine = new EnrichmentEngine();
    mockIsEnrichmentEnabled.mockReset();
    mockFindSourceFiles.mockReset();
    mockBuildPrompt.mockReset();
    mockCallLlm.mockReset();
    outputChannel.appendLine.mockClear();
    delete process.env["AGENTGRAPH_ANTHROPIC_KEY"];
  });

  afterEach(() => {
    delete process.env["AGENTGRAPH_ANTHROPIC_KEY"];
  });

  it("returns early without calling source finder when consent gate is off", async () => {
    mockIsEnrichmentEnabled.mockReturnValue(false);

    await engine.enrich(makeConv(), makeFanout() as never, outputChannel as never);

    expect(mockFindSourceFiles).not.toHaveBeenCalled();
  });

  it("returns early and logs when API key is missing", async () => {
    mockIsEnrichmentEnabled.mockReturnValue(true);
    // No AGENTGRAPH_ANTHROPIC_KEY set

    await engine.enrich(makeConv(), makeFanout() as never, outputChannel as never);

    expect(mockFindSourceFiles).not.toHaveBeenCalled();
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("AGENTGRAPH_ANTHROPIC_KEY"),
    );
  });

  it("broadcasts mapped inferred arrow nodes on success", async () => {
    process.env["AGENTGRAPH_ANTHROPIC_KEY"] = "test-key";
    mockIsEnrichmentEnabled.mockReturnValue(true);
    mockFindSourceFiles.mockResolvedValue([]);
    mockBuildPrompt.mockReturnValue("the prompt");
    mockCallLlm.mockResolvedValue([arrowNode]);

    const fanout = makeFanout();
    await engine.enrich(makeConv(), fanout as never, outputChannel as never);

    expect(fanout.broadcastInferredNodes).toHaveBeenCalledWith(
      "t1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "inferred", fromParticipantId: "svc-a" }),
      ]),
    );
  });

  it("broadcasts mapped inferred action nodes on success", async () => {
    process.env["AGENTGRAPH_ANTHROPIC_KEY"] = "test-key";
    mockIsEnrichmentEnabled.mockReturnValue(true);
    mockFindSourceFiles.mockResolvedValue([]);
    mockBuildPrompt.mockReturnValue("prompt");
    mockCallLlm.mockResolvedValue([actionNode]);

    const fanout = makeFanout();
    await engine.enrich(makeConv(), fanout as never, outputChannel as never);

    expect(fanout.broadcastInferredNodes).toHaveBeenCalledWith(
      "t1",
      expect.arrayContaining([
        expect.objectContaining({ kind: "inferred", participantId: "svc-a" }),
      ]),
    );
  });

  it("does not broadcast when LLM returns null", async () => {
    process.env["AGENTGRAPH_ANTHROPIC_KEY"] = "key";
    mockIsEnrichmentEnabled.mockReturnValue(true);
    mockFindSourceFiles.mockResolvedValue([]);
    mockBuildPrompt.mockReturnValue("prompt");
    mockCallLlm.mockResolvedValue(null);

    const fanout = makeFanout();
    await engine.enrich(makeConv(), fanout as never, outputChannel as never);

    expect(fanout.broadcastInferredNodes).not.toHaveBeenCalled();
  });

  it("assigns unique ids to each mapped node", async () => {
    process.env["AGENTGRAPH_ANTHROPIC_KEY"] = "key";
    mockIsEnrichmentEnabled.mockReturnValue(true);
    mockFindSourceFiles.mockResolvedValue([]);
    mockBuildPrompt.mockReturnValue("prompt");
    mockCallLlm.mockResolvedValue([arrowNode, actionNode]);

    const fanout = makeFanout();
    await engine.enrich(makeConv(), fanout as never, outputChannel as never);

    const callArgs = fanout.broadcastInferredNodes.mock.calls[0]!;
    const nodes = callArgs[1] as { id: string }[];
    const ids = nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("passes the correct API key to callLlm", async () => {
    process.env["AGENTGRAPH_ANTHROPIC_KEY"] = "my-real-key";
    mockIsEnrichmentEnabled.mockReturnValue(true);
    mockFindSourceFiles.mockResolvedValue([]);
    mockBuildPrompt.mockReturnValue("prompt");
    mockCallLlm.mockResolvedValue([]);

    await engine.enrich(makeConv(), makeFanout() as never, outputChannel as never);

    expect(mockCallLlm).toHaveBeenCalledWith(
      "my-real-key",
      "prompt",
      outputChannel,
    );
  });
});
