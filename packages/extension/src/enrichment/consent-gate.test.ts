import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetConfiguration } = vi.hoisted(() => ({
  mockGetConfiguration: vi.fn(),
}));

vi.mock("vscode", () => ({
  workspace: { getConfiguration: mockGetConfiguration },
}));

import { isEnrichmentEnabled } from "./consent-gate.js";

const outputChannel = { appendLine: vi.fn() };

describe("isEnrichmentEnabled", () => {
  beforeEach(() => {
    mockGetConfiguration.mockReset();
    outputChannel.appendLine.mockClear();
    delete process.env["AGENTGRAPH_TRACE_CONTENT"];
  });

  afterEach(() => {
    delete process.env["AGENTGRAPH_TRACE_CONTENT"];
  });

  it("returns false when enableLLMEnrichment is false", () => {
    mockGetConfiguration.mockReturnValue({ get: () => false });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(false);
  });

  it("returns true when enableLLMEnrichment is true", () => {
    mockGetConfiguration.mockReturnValue({ get: () => true });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(true);
  });

  it("defaults to false when config returns undefined", () => {
    mockGetConfiguration.mockReturnValue({ get: () => undefined });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(false);
  });

  it("returns false and logs when AGENTGRAPH_TRACE_CONTENT=false even if setting is true", () => {
    process.env["AGENTGRAPH_TRACE_CONTENT"] = "false";
    mockGetConfiguration.mockReturnValue({ get: () => true });

    const result = isEnrichmentEnabled(outputChannel as never);

    expect(result).toBe(false);
    expect(outputChannel.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("AGENTGRAPH_TRACE_CONTENT"),
    );
  });

  it("does not short-circuit on AGENTGRAPH_TRACE_CONTENT with other values", () => {
    process.env["AGENTGRAPH_TRACE_CONTENT"] = "true";
    mockGetConfiguration.mockReturnValue({ get: () => true });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(true);
  });

  it("blocks when AGENTGRAPH_TRACE_CONTENT=FALSE (uppercase)", () => {
    process.env["AGENTGRAPH_TRACE_CONTENT"] = "FALSE";
    mockGetConfiguration.mockReturnValue({ get: () => true });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(false);
    expect(outputChannel.appendLine).toHaveBeenCalled();
  });

  it("blocks when AGENTGRAPH_TRACE_CONTENT=False (mixed case)", () => {
    process.env["AGENTGRAPH_TRACE_CONTENT"] = "False";
    mockGetConfiguration.mockReturnValue({ get: () => true });

    expect(isEnrichmentEnabled(outputChannel as never)).toBe(false);
  });
});
