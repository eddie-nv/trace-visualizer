import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@agentgraph/sdk", () => ({ init: vi.fn() }));

interface FlagCarrier {
  __AGENTGRAPH__?: { registered?: boolean };
}

afterAll(() => {
  delete (globalThis as FlagCarrier).__AGENTGRAPH__;
});

describe("@agentgraph/register", () => {
  it("loads as a side-effect-only module that registers exactly once", async () => {
    // Arrange / Act
    const moduleExports = await import("@agentgraph/register");
    const sdk = await import("@agentgraph/sdk");

    // Assert — preload entries must expose no API surface (DESIGN §1)
    expect(Object.keys(moduleExports)).toEqual([]);
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect((globalThis as FlagCarrier).__AGENTGRAPH__?.registered).toBe(true);
  });

  it("re-importing after a module reset is a no-op thanks to the global flag", async () => {
    // Arrange — simulates a second copy of the entry loading in the same process
    await import("@agentgraph/register");
    vi.resetModules();

    // Act
    const freshSdk = await import("@agentgraph/sdk");
    await import("@agentgraph/register");

    // Assert
    expect(freshSdk.init).not.toHaveBeenCalled();
  });
});
