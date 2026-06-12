import type { SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { readEnvOptions, type EnvSource } from "./env.js";

/** Default OTLP HTTP base — Jaeger all-in-one (DESIGN §1, §6). */
export const DEFAULT_ENDPOINT = "http://localhost:4318";

const DEFAULT_SERVICE_NAME = "unknown_service";

/** Options for {@link init} (DESIGN §1). Env vars fill any omitted field. */
export interface InitOptions {
  /** Stamped as `agentgraph.agent.id` on every span (fallback when no `withAgent` context). */
  agentId?: string;
  /** Resource `service.name`; defaults to `npm_package_name`. */
  serviceName?: string;
  /** OTLP HTTP base; the exporter posts to `${endpoint}/v1/traces`. */
  endpoint?: string;
  headers?: Record<string, string>;
  /** Escape hatch: replaces the default OTLP exporter. */
  exporter?: SpanExporter;
  /** Additive: appended after the default (stamping) processor. */
  processor?: SpanProcessor;
  /** Use a SimpleSpanProcessor instead of BatchSpanProcessor. */
  disableBatch?: boolean;
  /** Content capture (DESIGN §4); threaded into core's gate. */
  traceContent?: boolean;
  /** Install the tier-1 fetch hook. Default true. */
  instrumentFetch?: boolean;
}

/** Fully resolved init configuration: options → env → defaults. */
export interface ResolvedConfig {
  agentId: string | undefined;
  serviceName: string;
  endpoint: string;
  headers: Record<string, string>;
  exporter: SpanExporter | undefined;
  processor: SpanProcessor | undefined;
  disableBatch: boolean;
  traceContent: boolean | undefined;
  instrumentFetch: boolean;
}

/**
 * Resolve options against the env var table (DESIGN §1). Explicit options
 * win; env vars fill the gaps; defaults last. Fails fast on an unparseable
 * endpoint so misconfiguration surfaces at init time, not first export.
 */
export function resolveConfig(
  options: InitOptions = {},
  env: EnvSource = process.env,
): ResolvedConfig {
  const fromEnv = readEnvOptions(env);
  const endpoint = options.endpoint ?? fromEnv.endpoint ?? DEFAULT_ENDPOINT;
  validateEndpoint(endpoint);
  return {
    agentId: normalizeAgentId(options.agentId ?? fromEnv.agentId),
    serviceName: options.serviceName ?? env["npm_package_name"] ?? DEFAULT_SERVICE_NAME,
    endpoint,
    headers: options.headers ?? fromEnv.headers ?? {},
    exporter: options.exporter,
    processor: options.processor,
    disableBatch: options.disableBatch ?? fromEnv.disableBatch ?? false,
    traceContent: options.traceContent ?? fromEnv.traceContent,
    instrumentFetch: options.instrumentFetch ?? true,
  };
}

function validateEndpoint(endpoint: string): void {
  try {
    new URL(endpoint);
  } catch {
    throw new Error(
      `agentgraph: invalid endpoint "${endpoint}" — expected a URL like ${DEFAULT_ENDPOINT}`,
    );
  }
}

function normalizeAgentId(agentId: string | undefined): string | undefined {
  if (agentId === undefined) {
    return undefined;
  }
  if (agentId.trim() === "") {
    console.warn("agentgraph: ignoring empty agentId");
    return undefined;
  }
  return agentId;
}
