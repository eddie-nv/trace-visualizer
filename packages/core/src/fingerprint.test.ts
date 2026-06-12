import { describe, expect, it } from "vitest";
import { computeAgentFingerprint } from "@agentgraph/core";

const BASE_INPUT = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  toolNames: ["get_weather", "search"],
  systemPrompt: "You are a helpful assistant.",
} as const;

describe("computeAgentFingerprint", () => {
  it("is deterministic for identical input", () => {
    expect(computeAgentFingerprint(BASE_INPUT)).toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("returns a 16-character lowercase hex string", () => {
    expect(computeAgentFingerprint(BASE_INPUT)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores tool name order", () => {
    // Arrange
    const reversed = { ...BASE_INPUT, toolNames: ["search", "get_weather"] };

    // Act / Assert
    expect(computeAgentFingerprint(reversed)).toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("changes when the provider differs", () => {
    const other = { ...BASE_INPUT, provider: "openai" };

    expect(computeAgentFingerprint(other)).not.toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("changes when the model differs", () => {
    const other = { ...BASE_INPUT, model: "claude-haiku-4-5" };

    expect(computeAgentFingerprint(other)).not.toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("changes when the tool set differs", () => {
    const other = { ...BASE_INPUT, toolNames: ["get_weather"] };

    expect(computeAgentFingerprint(other)).not.toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("changes when the system prompt prefix differs", () => {
    const other = { ...BASE_INPUT, systemPrompt: "You are a terse assistant." };

    expect(computeAgentFingerprint(other)).not.toBe(computeAgentFingerprint(BASE_INPUT));
  });

  it("ignores system prompt content beyond 256 characters", () => {
    // DESIGN Q4 — only the first 256 chars participate, so template
    // interpolation deep in the prompt does not fragment the cluster.
    const prefix = "x".repeat(256);
    const inputA = { ...BASE_INPUT, systemPrompt: `${prefix}AAAA` };
    const inputB = { ...BASE_INPUT, systemPrompt: `${prefix}BBBB` };

    expect(computeAgentFingerprint(inputA)).toBe(computeAgentFingerprint(inputB));
  });

  it("treats absent and empty toolNames the same", () => {
    const withoutTools = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const emptyTools = { ...withoutTools, toolNames: [] as const };

    expect(computeAgentFingerprint(withoutTools)).toBe(computeAgentFingerprint(emptyTools));
  });

  it("throws TypeError when provider is empty", () => {
    expect(() => computeAgentFingerprint({ ...BASE_INPUT, provider: "" })).toThrow(TypeError);
  });

  it("throws TypeError when model is empty", () => {
    expect(() => computeAgentFingerprint({ ...BASE_INPUT, model: "" })).toThrow(TypeError);
  });
});
