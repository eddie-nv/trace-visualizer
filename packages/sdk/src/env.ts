/**
 * `AGENTGRAPH_*` env var table (DESIGN §1) — read once in `init()`, options
 * take precedence (see `config.ts`).
 */

/** Sparse options derived from env vars — fields exist only when set. */
export interface EnvOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  traceContent?: boolean;
  disableBatch?: boolean;
  agentId?: string;
  /**
   * Reserved: consumed by the `@agentgraph/register` preload (M4) to opt
   * into tier-3 module hooks (wired in M6). `init()` deliberately ignores it.
   */
  instrumentSdks?: boolean;
  /**
   * TEST-ONLY (DESIGN §6 Test B): extra `provider=origin` matches for the
   * fetch hook so an E2E harness can stand in a deterministic local mock of
   * a provider endpoint. Never set in production.
   */
  testMatchOrigins?: Record<string, string>;
}

export type EnvSource = Record<string, string | undefined>;

/**
 * Parse the `AGENTGRAPH_*` env vars. Boolean parsing is deliberately strict:
 * `AGENTGRAPH_TRACE_CONTENT` only acts on the literal `"false"` (DESIGN §4)
 * and the opt-in flags only act on the literal `"true"`.
 */
export function readEnvOptions(env: EnvSource = process.env): EnvOptions {
  return {
    ...(env["AGENTGRAPH_ENDPOINT"] !== undefined && { endpoint: env["AGENTGRAPH_ENDPOINT"] }),
    ...(env["AGENTGRAPH_HEADERS"] !== undefined && {
      headers: parseHeaders(env["AGENTGRAPH_HEADERS"]),
    }),
    ...(env["AGENTGRAPH_TRACE_CONTENT"] === "false" && { traceContent: false }),
    ...(env["AGENTGRAPH_DISABLE_BATCH"] === "true" && { disableBatch: true }),
    ...(env["AGENTGRAPH_AGENT_ID"] !== undefined && { agentId: env["AGENTGRAPH_AGENT_ID"] }),
    ...(env["AGENTGRAPH_INSTRUMENT_SDKS"] === "true" && { instrumentSdks: true }),
    ...parseTestMatchOrigins(env["AGENTGRAPH_TEST_MATCH_ORIGIN"]),
  };
}

/**
 * Parse the test-only `provider=origin[,provider=origin]` override. Values
 * are normalized to their URL origin; malformed entries are dropped with a
 * warning. Returns a spreadable fragment so an unset/empty var adds nothing.
 */
function parseTestMatchOrigins(raw: string | undefined): Pick<EnvOptions, "testMatchOrigins"> {
  if (raw === undefined) {
    return {};
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(parseTestMatchOriginEntry)
    .filter((pair): pair is [string, string] => pair !== undefined);
  return entries.length === 0 ? {} : { testMatchOrigins: Object.fromEntries(entries) };
}

function parseTestMatchOriginEntry(entry: string): [string, string] | undefined {
  const separator = entry.indexOf("=");
  const provider = separator === -1 ? "" : entry.slice(0, separator).trim();
  const value = separator === -1 ? "" : entry.slice(separator + 1).trim();
  if (provider === "") {
    console.warn(
      `agentgraph: ignoring malformed AGENTGRAPH_TEST_MATCH_ORIGIN entry "${entry}" (expected "provider=origin")`,
    );
    return undefined;
  }
  try {
    return [provider, new URL(value).origin];
  } catch {
    console.warn(
      `agentgraph: ignoring AGENTGRAPH_TEST_MATCH_ORIGIN entry "${entry}" — origin is not a valid URL`,
    );
    return undefined;
  }
}

/** RFC 9110 token chars — anything else in a key risks header injection. */
const VALID_HEADER_KEY = /^[\w!#$%&'*+.^`|~-]+$/;

/** Control chars (incl. CR/LF and NUL) — Node's http layer rejects these with errors that echo the value. */
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Parse the `k=v,k2=v2` header format (`AGENTGRAPH_HEADERS`, OTLP convention).
 * Values may contain `=` (split on the first one). Malformed entries —
 * missing `=`, non-token key, control chars anywhere — are dropped with a
 * warning that never echoes the entry: headers may carry auth tokens, and
 * forwarding a bad entry would let Node's http layer echo it in its own
 * error message.
 */
export function parseHeaders(raw: string): Record<string, string> {
  const pairs = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(parseHeaderEntry)
    .filter((pair): pair is [string, string] => pair !== undefined);
  return Object.fromEntries(pairs);
}

function parseHeaderEntry(entry: string): [string, string] | undefined {
  const separator = entry.indexOf("=");
  const key = separator === -1 ? "" : entry.slice(0, separator).trim();
  const value = separator === -1 ? "" : entry.slice(separator + 1).trim();
  if (!VALID_HEADER_KEY.test(key) || HAS_CONTROL_CHARS.test(value)) {
    console.warn(
      'agentgraph: ignoring malformed AGENTGRAPH_HEADERS entry (expected "key=value"; entry not shown in case it contains a secret)',
    );
    return undefined;
  }
  return [key, value];
}
