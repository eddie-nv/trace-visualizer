import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ENDPOINT, resolveConfig } from "./config.js";

describe("resolveConfig", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies defaults when neither options nor env provide values", () => {
    // Arrange / Act
    const config = resolveConfig(undefined, {});

    // Assert
    expect(config.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(config.headers).toEqual({});
    expect(config.disableBatch).toBe(false);
    expect(config.instrumentFetch).toBe(true);
    expect(config.agentId).toBeUndefined();
    expect(config.traceContent).toBeUndefined();
  });

  it("prefers explicit options over env vars (env precedence)", () => {
    // Arrange
    const env = {
      AGENTGRAPH_ENDPOINT: "http://env:4318",
      AGENTGRAPH_AGENT_ID: "env-agent",
      AGENTGRAPH_DISABLE_BATCH: "true",
      AGENTGRAPH_TRACE_CONTENT: "false",
      AGENTGRAPH_HEADERS: "from=env",
    };

    // Act
    const config = resolveConfig(
      {
        endpoint: "http://options:4318",
        agentId: "options-agent",
        disableBatch: false,
        traceContent: true,
        headers: { from: "options" },
      },
      env,
    );

    // Assert
    expect(config.endpoint).toBe("http://options:4318");
    expect(config.agentId).toBe("options-agent");
    expect(config.disableBatch).toBe(false);
    expect(config.traceContent).toBe(true);
    expect(config.headers).toEqual({ from: "options" });
  });

  it("falls back to env vars when options omit a field", () => {
    const env = {
      AGENTGRAPH_ENDPOINT: "http://env:4318",
      AGENTGRAPH_AGENT_ID: "env-agent",
    };

    const config = resolveConfig({ serviceName: "svc" }, env);

    expect(config.endpoint).toBe("http://env:4318");
    expect(config.agentId).toBe("env-agent");
  });

  it("defaults serviceName to npm_package_name, then to unknown_service", () => {
    expect(resolveConfig(undefined, { npm_package_name: "my-app" }).serviceName).toBe("my-app");
    expect(resolveConfig(undefined, {}).serviceName).toBe("unknown_service");
    expect(resolveConfig({ serviceName: "svc" }, { npm_package_name: "my-app" }).serviceName).toBe(
      "svc",
    );
  });

  it("throws a clear error for an unparseable endpoint (fail fast at init, not at export)", () => {
    expect(() => resolveConfig({ endpoint: "not-a-url" }, {})).toThrow(/endpoint/i);
  });

  it("ignores an empty or whitespace-only agentId with a warning", () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act
    const config = resolveConfig({ agentId: "  " }, {});

    // Assert
    expect(config.agentId).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

describe("testMatchOrigins (test-only override)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is undefined by default", () => {
    expect(resolveConfig(undefined, {}).testMatchOrigins).toBeUndefined();
  });

  it("is surfaced from the env var with a test-only warning", () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act
    const config = resolveConfig(undefined, {
      AGENTGRAPH_TEST_MATCH_ORIGIN: "anthropic=http://127.0.0.1:9999",
    });

    // Assert
    expect(config.testMatchOrigins).toEqual({ anthropic: "http://127.0.0.1:9999" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("test"));
  });
});

describe("instrumentModules / instrumentSdks (M6 tiers 2-3)", () => {
  it("passes instrumentModules through from options", () => {
    const anthropic = { fake: true };

    const config = resolveConfig({ instrumentModules: { anthropic } }, {});

    expect(config.instrumentModules).toEqual({ anthropic });
  });

  it("defaults instrumentModules to undefined", () => {
    expect(resolveConfig(undefined, {}).instrumentModules).toBeUndefined();
  });

  it("instrumentSdks is env-only and strict: true only on the literal 'true'", () => {
    expect(resolveConfig(undefined, {}).instrumentSdks).toBe(false);
    expect(resolveConfig(undefined, { AGENTGRAPH_INSTRUMENT_SDKS: "true" }).instrumentSdks).toBe(
      true,
    );
    expect(resolveConfig(undefined, { AGENTGRAPH_INSTRUMENT_SDKS: "1" }).instrumentSdks).toBe(
      false,
    );
  });
});
