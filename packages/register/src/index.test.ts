import { describe, expect, it } from "vitest";

describe("@agentgraph/register", () => {
  it("loads as a side-effect-only module without throwing", async () => {
    // Arrange / Act
    const moduleExports = await import("@agentgraph/register");

    // Assert — preload entries must expose no API surface (DESIGN §1)
    expect(Object.keys(moduleExports)).toEqual([]);
  });
});
