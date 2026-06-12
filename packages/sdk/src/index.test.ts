import { describe, expect, it } from "vitest";
import {
  forceFlush,
  init,
  shutdown,
  TRACER_NAME,
  withAgent,
  withConversation,
} from "@agentgraph/sdk";

describe("@agentgraph/sdk", () => {
  it("re-exports the tracer name from @agentgraph/core (dependency direction sdk → core)", () => {
    // Arrange / Act — constant re-export

    // Assert
    expect(TRACER_NAME).toBe("agentgraph");
  });

  it("exposes the full M3 public surface (DESIGN §1)", () => {
    for (const fn of [init, withAgent, withConversation, forceFlush, shutdown]) {
      expect(fn).toBeTypeOf("function");
    }
  });
});
