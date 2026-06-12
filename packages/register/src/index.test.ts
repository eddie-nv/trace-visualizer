import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@agentgraph/sdk", () => ({ init: vi.fn() }));

interface FlagCarrier {
  __AGENTGRAPH__?: { registered?: boolean };
}

// Each test arranges its own registry + global-flag state so the suite is
// order-independent: the entry's side effect runs on (re-)import.
beforeEach(() => {
  vi.resetModules();
  delete (globalThis as FlagCarrier).__AGENTGRAPH__;
});

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

  it("does not re-init when a prior copy already set the global flag", async () => {
    // Arrange — as if the twin entry already registered in this process
    (globalThis as FlagCarrier).__AGENTGRAPH__ = { registered: true };
    const sdk = await import("@agentgraph/sdk");
    vi.mocked(sdk.init).mockClear();

    // Act
    await import("@agentgraph/register");

    // Assert
    expect(sdk.init).not.toHaveBeenCalled();
  });
});
