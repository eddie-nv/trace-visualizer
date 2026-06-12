import { afterEach, describe, expect, it, vi } from "vitest";
import { parseHeaders, readEnvOptions } from "./env.js";

describe("parseHeaders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses k=v,k2=v2 into a header record", () => {
    // Arrange / Act
    const headers = parseHeaders("authorization=Bearer abc,x-tenant=acme");

    // Assert
    expect(headers).toEqual({ authorization: "Bearer abc", "x-tenant": "acme" });
  });

  it("trims whitespace around entries, keys, and values", () => {
    const headers = parseHeaders(" a = 1 , b = 2 ");

    expect(headers).toEqual({ a: "1", b: "2" });
  });

  it("splits on the first = so values may contain =", () => {
    const headers = parseHeaders("authorization=Basic dXNlcj1wYXNz==");

    expect(headers).toEqual({ authorization: "Basic dXNlcj1wYXNz==" });
  });

  it("skips malformed entries (no =, empty key) with a warning and keeps valid ones", () => {
    // Arrange
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Act
    const headers = parseHeaders("good=1,noequals,=orphan,also=fine");

    // Assert
    expect(headers).toEqual({ good: "1", also: "fine" });
    expect(warn).toHaveBeenCalled();
  });

  it("returns an empty record for an empty string", () => {
    expect(parseHeaders("")).toEqual({});
  });
});

describe("readEnvOptions", () => {
  it("reads the full AGENTGRAPH_* env var table", () => {
    // Arrange
    const env = {
      AGENTGRAPH_ENDPOINT: "https://collector.example.com:4318",
      AGENTGRAPH_HEADERS: "authorization=Bearer abc",
      AGENTGRAPH_TRACE_CONTENT: "false",
      AGENTGRAPH_DISABLE_BATCH: "true",
      AGENTGRAPH_AGENT_ID: "billing-bot",
      AGENTGRAPH_INSTRUMENT_SDKS: "true",
    };

    // Act
    const options = readEnvOptions(env);

    // Assert
    expect(options).toEqual({
      endpoint: "https://collector.example.com:4318",
      headers: { authorization: "Bearer abc" },
      traceContent: false,
      disableBatch: true,
      agentId: "billing-bot",
      instrumentSdks: true,
    });
  });

  it("leaves fields unset when the env vars are absent", () => {
    const options = readEnvOptions({});

    expect(options).toEqual({});
  });

  it("treats only the literal string 'false' as traceContent false", () => {
    expect(readEnvOptions({ AGENTGRAPH_TRACE_CONTENT: "0" })).toEqual({});
    expect(readEnvOptions({ AGENTGRAPH_TRACE_CONTENT: "true" })).toEqual({});
    expect(readEnvOptions({ AGENTGRAPH_TRACE_CONTENT: "false" })).toEqual({ traceContent: false });
  });

  it("treats only the literal string 'true' as disableBatch / instrumentSdks true", () => {
    expect(readEnvOptions({ AGENTGRAPH_DISABLE_BATCH: "1" })).toEqual({});
    expect(readEnvOptions({ AGENTGRAPH_INSTRUMENT_SDKS: "yes" })).toEqual({});
  });
});
