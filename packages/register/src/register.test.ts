import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { register, type AgentGraphGlobalCarrier } from "./register.js";

describe("register", () => {
  let warnSpy: MockInstance;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("calls init and sets the registered flag on first registration", () => {
    // Arrange
    const initFn = vi.fn();
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act
    register({ initFn, globalObj });

    // Assert
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(globalObj.__AGENTGRAPH__?.registered).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("is a no-op when the registered flag is already set", () => {
    // Arrange — another copy of this package (e.g. the CJS twin) won the race
    const initFn = vi.fn();
    const globalObj: AgentGraphGlobalCarrier = { __AGENTGRAPH__: { registered: true } };

    // Act
    register({ initFn, globalObj });

    // Assert
    expect(initFn).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not call init again on a second registration", () => {
    // Arrange
    const initFn = vi.fn();
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act
    register({ initFn, globalObj });
    register({ initFn, globalObj });

    // Assert
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  it("preserves unrelated properties on an existing global state object", () => {
    // Arrange — future fields (e.g. M6 module-hook flags) must survive registration
    const initFn = vi.fn();
    const existingState = { registered: false, moduleHooksRegistered: true };
    const globalObj: AgentGraphGlobalCarrier = {
      __AGENTGRAPH__: existingState as AgentGraphGlobalCarrier["__AGENTGRAPH__"],
    };

    // Act
    register({ initFn, globalObj });

    // Assert — new object written (no mutation), foreign property carried over
    expect(globalObj.__AGENTGRAPH__).not.toBe(existingState);
    expect(existingState.registered).toBe(false);
    expect(globalObj.__AGENTGRAPH__).toMatchObject({
      registered: true,
      moduleHooksRegistered: true,
    });
  });

  it("downgrades an init failure to a single console.warn and does not throw", () => {
    // Arrange
    const initFn = vi.fn(() => {
      throw new Error("invalid endpoint");
    });
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act
    const act = () => register({ initFn, globalObj });

    // Assert
    expect(act).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("agentgraph"), expect.any(Error));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("invalid endpoint"),
      expect.any(Error),
    );
  });

  it("does not warn again when re-registered after a failure", () => {
    // Arrange — the flag is set before init so the twin entry never re-attempts
    const initFn = vi.fn(() => {
      throw new Error("boom");
    });
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act
    register({ initFn, globalObj });
    register({ initFn, globalObj });

    // Assert
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("warns without throwing when init throws a non-Error value", () => {
    // Arrange
    const initFn = vi.fn(() => {
      // eslint-disable-next-line no-throw-literal
      throw "string failure";
    });
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act
    const act = () => register({ initFn, globalObj });

    // Assert
    expect(act).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("string failure"),
      "string failure",
    );
  });

  it("calls init when the registered flag is explicitly false, not just absent", () => {
    // Arrange
    const initFn = vi.fn();
    const globalObj: AgentGraphGlobalCarrier = { __AGENTGRAPH__: { registered: false } };

    // Act
    register({ initFn, globalObj });

    // Assert
    expect(initFn).toHaveBeenCalledTimes(1);
    expect(globalObj.__AGENTGRAPH__?.registered).toBe(true);
  });

  it("does not throw even when console.warn itself throws", () => {
    // Arrange — a host may replace console.warn with a throwing stub
    warnSpy.mockImplementation(() => {
      throw new Error("console is broken");
    });
    const initFn = vi.fn(() => {
      throw new Error("init failure");
    });
    const globalObj: AgentGraphGlobalCarrier = {};

    // Act / Assert
    expect(() => register({ initFn, globalObj })).not.toThrow();
  });
});
