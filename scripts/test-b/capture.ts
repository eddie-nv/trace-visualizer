/**
 * Full HTTP response capture and byte-exact comparison for Test B criterion 4
 * (DESIGN §6): status, headers minus date-variant ones, and the complete body
 * byte sequence (for SSE, the exact byte stream) must be identical with and
 * without the preload.
 */

/** Headers that legitimately differ between two otherwise identical runs. */
const VOLATILE_HEADERS = new Set(["date"]);

export interface CapturedResponse {
  readonly status: number;
  /** Sorted `name: value` pairs, volatile headers removed. */
  readonly headers: readonly string[];
  readonly body: Uint8Array;
}

export async function captureResponse(url: string, init: RequestInit): Promise<CapturedResponse> {
  const response = await fetch(url, init);
  const body = new Uint8Array(await response.arrayBuffer());
  const headers = [...response.headers.entries()]
    .filter(([name]) => !VOLATILE_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .sort();
  return { status: response.status, headers, body };
}

export function capturePost(
  origin: string,
  path: string,
  body: unknown,
): Promise<CapturedResponse> {
  return captureResponse(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Returns a human-readable description of the first difference, or undefined when byte-identical. */
export function diffCaptures(a: CapturedResponse, b: CapturedResponse): string | undefined {
  if (a.status !== b.status) {
    return `status differs: ${a.status} vs ${b.status}`;
  }
  if (a.headers.join("\n") !== b.headers.join("\n")) {
    return `headers differ:\n--- a\n${a.headers.join("\n")}\n--- b\n${b.headers.join("\n")}`;
  }
  if (a.body.length !== b.body.length) {
    return `body length differs: ${a.body.length} vs ${b.body.length} bytes`;
  }
  for (let i = 0; i < a.body.length; i += 1) {
    if (a.body[i] !== b.body[i]) {
      const context = new TextDecoder().decode(a.body.slice(Math.max(0, i - 40), i + 40));
      return `body differs at byte ${i} (context: …${context}…)`;
    }
  }
  return undefined;
}
