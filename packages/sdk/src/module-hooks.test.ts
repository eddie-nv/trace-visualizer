import { afterEach, describe, expect, it, vi } from "vitest";
import { activateTier3 } from "./module-hooks.js";

describe("activateTier3 (AGENTGRAPH_INSTRUMENT_SDKS)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers the ESM loader hook and enables the instrumentations", () => {
    // Arrange
    const registerFn = vi.fn();
    const enableFn = vi.fn();

    // Act
    const activated = activateTier3({}, { registerFn, enableFn });

    // Assert
    expect(activated).toBe(true);
    expect(registerFn).toHaveBeenCalledWith("import-in-the-middle/hook.mjs", expect.anything());
    expect(enableFn).toHaveBeenCalledTimes(1);
    const instrumentations = enableFn.mock.calls[0]![0] as Array<{ instrumentationName: string }>;
    expect(instrumentations).toHaveLength(2);
  });

  it("warns but still enables CJS interception when the ESM loader hook throws (Sentry pattern)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registerFn = vi.fn(() => {
      throw new Error("no import-in-the-middle");
    });
    const enableFn = vi.fn();

    const activated = activateTier3({}, { registerFn, enableFn });

    expect(activated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(enableFn).toHaveBeenCalledTimes(1);
  });

  it("warns when module.register is unavailable on this runtime (null seam)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const enableFn = vi.fn();

    const activated = activateTier3({}, { registerFn: null, enableFn });

    expect(activated).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(enableFn).toHaveBeenCalledTimes(1);
  });

  it("never throws and returns false when even instrumentation enabling fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const enableFn = vi.fn(() => {
      throw new Error("instrumentation exploded");
    });

    const activated = activateTier3({}, { registerFn: vi.fn(), enableFn });

    expect(activated).toBe(false);
    expect(warn).toHaveBeenCalled();
  });
});
