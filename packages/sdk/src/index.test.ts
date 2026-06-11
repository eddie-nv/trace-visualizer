import { describe, expect, it } from "vitest";
import { TRACER_NAME } from "@agentgraph/sdk";

describe("@agentgraph/sdk", () => {
  it("re-exports the tracer name from @agentgraph/core (dependency direction sdk → core)", () => {
    // Arrange / Act — constant re-export

    // Assert
    expect(TRACER_NAME).toBe("agentgraph");
  });
});
