import type { Usage } from "./manual.js";
import type { SseEvent } from "./sse.js";

/**
 * Provider-neutral view of a matched LLM request body (DESIGN §2.1). Every
 * field is optional — adapters extract what the wire format carries and the
 * fetch hook emits only what is present.
 */
export interface ParsedRequest {
  readonly model?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  /** Serialized into `gen_ai.input.messages` when content is on. */
  readonly messages?: unknown;
  /** Already in semconv parts shape; serialized into `gen_ai.system_instructions`. */
  readonly systemInstructions?: unknown;
  /** Serialized into `gen_ai.tool.definitions` when content is on. */
  readonly toolDefinitions?: unknown;
  /** Inputs to `agentgraph.agent.fingerprint` (DESIGN §2.2). */
  readonly toolNames?: readonly string[];
  readonly systemPromptText?: string;
}

/** Provider-neutral view of a completed response (JSON body or SSE stream). */
export interface ParsedResponse {
  readonly id?: string;
  readonly model?: string;
  readonly finishReasons?: readonly string[];
  readonly usage?: Readonly<Usage>;
  /** Serialized into `gen_ai.output.messages` when content is on. */
  readonly outputMessages?: unknown;
}

/**
 * Accumulates provider SSE events into a {@link ParsedResponse} (DESIGN §3
 * streaming). `onEvent` may throw on malformed events — the fetch hook
 * isolates each call so one bad event cannot abort accumulation.
 */
export interface StreamAccumulator {
  onEvent(event: SseEvent): void;
  finish(): ParsedResponse;
}

/** One supported provider endpoint (DESIGN §3 tier 1). */
export interface ProviderAdapter {
  readonly providerName: string;
  isMatch(url: URL, method: string): boolean;
  parseRequest(body: Record<string, unknown>): ParsedRequest;
  parseResponse(json: unknown): ParsedResponse;
  createStreamAccumulator(): StreamAccumulator;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Non-JSON SSE data lines are protocol noise, not errors, at the adapter layer. */
export function tolerantJsonParse(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}
