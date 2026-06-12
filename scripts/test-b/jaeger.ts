/**
 * Jaeger query-API helpers for the Test B harness (DESIGN §6): all pass/fail
 * decisions are made against what Jaeger actually stored, not in-process state.
 */

export const JAEGER_QUERY_URL = process.env["JAEGER_QUERY_URL"] ?? "http://localhost:16686";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 20_000;
const SETTLE_DELAY_MS = 1_000;

export interface JaegerTag {
  readonly key: string;
  readonly value: unknown;
}

export interface JaegerSpanReference {
  readonly refType: string;
  readonly traceID: string;
  readonly spanID: string;
}

export interface JaegerSpan {
  readonly traceID: string;
  readonly spanID: string;
  readonly operationName: string;
  readonly tags: readonly JaegerTag[];
  /** Microseconds since epoch. */
  readonly startTime: number;
  /** Microseconds. */
  readonly duration: number;
  readonly references?: readonly JaegerSpanReference[];
}

interface JaegerTracesResponse {
  readonly data: ReadonlyArray<{ readonly spans: readonly JaegerSpan[] }>;
}

export function tagValue(span: JaegerSpan, key: string): unknown {
  return span.tags.find((tag) => tag.key === key)?.value;
}

/** All tags as a plain attributes record (the query-contract input shape). */
export function tagRecord(span: JaegerSpan): Record<string, unknown> {
  return Object.fromEntries(span.tags.map((tag) => [tag.key, tag.value]));
}

/** The CHILD_OF parent span id, if any. */
export function parentSpanId(span: JaegerSpan): string | undefined {
  return span.references?.find((ref) => ref.refType === "CHILD_OF")?.spanID;
}

/** Raw trace JSON (`/api/traces/{id}`) — committed as the Test A fixture. */
export async function fetchTraceJson(traceId: string): Promise<unknown> {
  const response = await fetch(`${JAEGER_QUERY_URL}/api/traces/${encodeURIComponent(traceId)}`);
  if (!response.ok) {
    throw new Error(`jaeger: could not fetch trace ${traceId} (HTTP ${response.status})`);
  }
  return response.json();
}

export async function isJaegerReachable(): Promise<boolean> {
  const response = await fetch(`${JAEGER_QUERY_URL}/api/services`).catch(() => undefined);
  return response?.ok === true;
}

interface SpanFetchResult {
  readonly spans: JaegerSpan[];
  /** Set when the query itself failed — "0 spans" and "Jaeger down" must stay distinguishable. */
  readonly queryFailure?: string;
}

async function fetchServiceSpans(service: string): Promise<SpanFetchResult> {
  const url = `${JAEGER_QUERY_URL}/api/traces?service=${encodeURIComponent(service)}&limit=50`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    return { spans: [], queryFailure: error instanceof Error ? error.message : String(error) };
  }
  if (!response.ok) {
    await response.text().catch(() => undefined);
    return { spans: [], queryFailure: `HTTP ${response.status}` };
  }
  const body = (await response.json()) as JaegerTracesResponse;
  return { spans: body.data.flatMap((trace) => [...trace.spans]) };
}

/**
 * Poll until `service` has at least `expectedCount` spans (exports lag span
 * end by an OTLP POST plus Jaeger ingest). Throws on timeout — a missing span
 * is a primary Test B failure mode, never something to paper over.
 */
export async function waitForSpans(service: string, expectedCount: number): Promise<JaegerSpan[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last: SpanFetchResult = { spans: [] };
  while (Date.now() < deadline) {
    last = await fetchServiceSpans(service);
    if (last.spans.length >= expectedCount) {
      // Settle recheck: over-emission (e.g. broken tier dedup, M6 §3.4)
      // would race a >= poll — give late duplicates a chance to land so
      // exact-count assertions can catch them.
      await sleep(SETTLE_DELAY_MS);
      const settled = await fetchServiceSpans(service);
      return settled.spans.length > last.spans.length ? settled.spans : last.spans;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const failureNote =
    last.queryFailure === undefined ? "" : ` (last query failed: ${last.queryFailure})`;
  throw new Error(
    `jaeger: expected ${expectedCount} span(s) for service "${service}" within ${POLL_TIMEOUT_MS}ms, found ${last.spans.length}${failureNote}`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
