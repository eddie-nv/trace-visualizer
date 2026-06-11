import { ROOT_CONTEXT } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALLOW_TRACE_CONTENT_KEY, shouldSendContent } from "@agentgraph/core";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("shouldSendContent", () => {
  it("defaults to true with no config, env, or context override", () => {
    expect(shouldSendContent()).toBe(true);
  });

  it("returns false when config.traceContent is false", () => {
    expect(shouldSendContent({ traceContent: false })).toBe(false);
  });

  it("returns true when config.traceContent is true", () => {
    expect(shouldSendContent({ traceContent: true })).toBe(true);
  });

  it("returns false when AGENTGRAPH_TRACE_CONTENT env is 'false'", () => {
    // Arrange
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "false");

    // Act / Assert
    expect(shouldSendContent()).toBe(false);
  });

  it("returns false when env is 'false' even if config.traceContent is true", () => {
    // DESIGN §4 — off iff config.traceContent === false OR env === "false".
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "false");

    expect(shouldSendContent({ traceContent: true })).toBe(false);
  });

  it("treats unrecognized env values as the default (true)", () => {
    vi.stubEnv("AGENTGRAPH_TRACE_CONTENT", "0");

    expect(shouldSendContent()).toBe(true);
  });

  it("honors a context-key override of true above a config of false", () => {
    // Arrange — per-call re-enable, the OpenLLMetry CONTEXT_KEY_ALLOW_TRACE_CONTENT pattern.
    const ctx = ROOT_CONTEXT.setValue(ALLOW_TRACE_CONTENT_KEY, true);

    // Act / Assert
    expect(shouldSendContent({ traceContent: false }, ctx)).toBe(true);
  });

  it("honors a context-key override of false above the default of true", () => {
    const ctx = ROOT_CONTEXT.setValue(ALLOW_TRACE_CONTENT_KEY, false);

    expect(shouldSendContent(undefined, ctx)).toBe(false);
  });

  it("ignores non-boolean context-key values", () => {
    // Never trust external data — a string "false" must not act as an override.
    const ctx = ROOT_CONTEXT.setValue(ALLOW_TRACE_CONTENT_KEY, "false");

    expect(shouldSendContent(undefined, ctx)).toBe(true);
  });
});
