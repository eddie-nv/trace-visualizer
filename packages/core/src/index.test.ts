import { describe, expect, it } from "vitest";
import { TRACER_NAME } from "@agentgraph/core";

describe("@agentgraph/core", () => {
  it("exposes the agentgraph tracer name used for all span emission", () => {
    // Arrange / Act — constant export

    // Assert
    expect(TRACER_NAME).toBe("agentgraph");
  });
});
