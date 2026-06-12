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
  instrumentSdks?: boolean;
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
  };
}

/**
 * Parse the `k=v,k2=v2` header format (`AGENTGRAPH_HEADERS`, OTLP convention).
 * Values may contain `=` (split on the first one). Malformed entries are
 * dropped with a warning that never echoes the entry — headers may carry
 * auth tokens.
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
  if (key === "") {
    console.warn(
      'agentgraph: ignoring malformed AGENTGRAPH_HEADERS entry (expected "key=value"; entry not shown in case it contains a secret)',
    );
    return undefined;
  }
  return [key, entry.slice(separator + 1).trim()];
}
