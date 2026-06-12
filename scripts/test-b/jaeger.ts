/**
 * Jaeger query-API helpers for the Test B harness (DESIGN §6): all pass/fail
 * decisions are made against what Jaeger actually stored, not in-process state.
 */

export const JAEGER_QUERY_URL = process.env["JAEGER_QUERY_URL"] ?? "http://localhost:16686";

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 20_000;

export interface JaegerTag {
  readonly key: string;
  readonly value: unknown;
}

export interface JaegerSpan {
  readonly operationName: string;
  readonly tags: readonly JaegerTag[];
}

interface JaegerTracesResponse {
  readonly data: ReadonlyArray<{ readonly spans: readonly JaegerSpan[] }>;
}

export function tagValue(span: JaegerSpan, key: string): unknown {
  return span.tags.find((tag) => tag.key === key)?.value;
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
      return last.spans;
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
