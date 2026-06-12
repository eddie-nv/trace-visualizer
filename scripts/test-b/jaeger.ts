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

async function fetchServiceSpans(service: string): Promise<JaegerSpan[]> {
  const url = `${JAEGER_QUERY_URL}/api/traces?service=${encodeURIComponent(service)}&limit=50`;
  const response = await fetch(url).catch(() => undefined);
  if (response?.ok !== true) {
    return [];
  }
  const body = (await response.json()) as JaegerTracesResponse;
  return body.data.flatMap((trace) => [...trace.spans]);
}

/**
 * Poll until `service` has at least `expectedCount` spans (exports lag span
 * end by an OTLP POST plus Jaeger ingest). Throws on timeout — a missing span
 * is a primary Test B failure mode, never something to paper over.
 */
export async function waitForSpans(service: string, expectedCount: number): Promise<JaegerSpan[]> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let spans: JaegerSpan[] = [];
  while (Date.now() < deadline) {
    spans = await fetchServiceSpans(service);
    if (spans.length >= expectedCount) {
      return spans;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `jaeger: expected ${expectedCount} span(s) for service "${service}" within ${POLL_TIMEOUT_MS}ms, found ${spans.length}`,
  );
}

/** One non-polling read, for asserting that a service has NO spans. */
export async function fetchSpansOnce(service: string): Promise<JaegerSpan[]> {
  return fetchServiceSpans(service);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
