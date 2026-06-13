import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as http from "node:http";
import { createOtlpReceiver } from "./otlp-receiver.js";
import { SpanStore } from "./span-store.js";

function makeEnvelopeBody(traceId: string, spanId: string): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "test-svc" } }] },
        scopeSpans: [
          {
            spans: [
              { traceId, spanId, name: "op", startTimeUnixNano: "1000", endTimeUnixNano: "2000" },
            ],
          },
        ],
      },
    ],
  });
}

async function postTo(
  port: number,
  body: string,
  contentType = "application/json",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/v1/traces",
        method: "POST",
        headers: { "content-type": contentType },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

describe("createOtlpReceiver (HTTP server)", () => {
  let server: http.Server;
  let store: SpanStore;
  const onSpan = vi.fn();
  const onError = vi.fn();

  beforeEach(async () => {
    store = new SpanStore();
    onSpan.mockReset();
    onError.mockReset();
    await new Promise<void>((resolve) => {
      server = createOtlpReceiver(store, { port: 0, onSpan, onError });
      server.once("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  function getPort(): number {
    const addr = server.address();
    if (typeof addr === "object" && addr) return addr.port;
    throw new Error("server not listening");
  }

  it("returns 200 and adds span for valid OTLP POST", async () => {
    const port = getPort();
    const res = await postTo(port, makeEnvelopeBody("t1", "s1"));
    expect(res.status).toBe(200);
    expect(store.getConversations()).toHaveLength(1);
    expect(onSpan).toHaveBeenCalledOnce();
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await postTo(getPort(), "not json");
    expect(res.status).toBe(400);
    expect(onSpan).not.toHaveBeenCalled();
  });

  it("returns 415 for non-JSON content type", async () => {
    const res = await postTo(getPort(), makeEnvelopeBody("t1", "s1"), "application/x-protobuf");
    expect(res.status).toBe(415);
  });

  it("returns 404 for unrecognized paths", async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: getPort(), path: "/health", method: "GET" },
        (r) => resolve({ status: r.statusCode ?? 0 }),
      );
      req.on("error", reject);
      req.end();
    });
    expect(res.status).toBe(404);
  });

  it("binds to 127.0.0.1 only (loopback)", () => {
    const addr = server.address();
    expect(typeof addr === "object" && addr?.address).toBe("127.0.0.1");
  });
});
