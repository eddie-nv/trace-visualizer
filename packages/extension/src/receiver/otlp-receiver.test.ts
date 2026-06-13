import { describe, it, expect, beforeEach, vi } from "vitest";
import { processOtlpBody } from "./otlp-receiver.js";
import { SpanStore } from "./span-store.js";
import type { OtlpEnvelope } from "./otlp-types.js";

function makeEnvelope(traceId: string, spanId: string, serviceName = "svc"): OtlpEnvelope {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId,
                name: "test-op",
                startTimeUnixNano: "1000000000",
                endTimeUnixNano: "2000000000",
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("processOtlpBody", () => {
  let store: SpanStore;
  const onSpan = vi.fn();

  beforeEach(() => {
    store = new SpanStore();
    onSpan.mockReset();
  });

  it("returns 200 and adds span to store for valid OTLP JSON", () => {
    const body = JSON.stringify(makeEnvelope("trace1", "span1"));
    const result = processOtlpBody(body, "application/json", store, onSpan);

    expect(result.status).toBe(200);
    expect(store.getConversations()).toHaveLength(1);
    expect(store.getConversations()[0]?.spans[0]?.span.spanId).toBe("span1");
  });

  it("calls onSpan callback for each span added", () => {
    const body = JSON.stringify(makeEnvelope("trace1", "span1", "my-service"));
    processOtlpBody(body, "application/json", store, onSpan);

    expect(onSpan).toHaveBeenCalledOnce();
    expect(onSpan).toHaveBeenCalledWith("trace1", expect.objectContaining({ spanId: "span1" }), "my-service");
  });

  it("returns 400 for invalid JSON", () => {
    const result = processOtlpBody("not-json{{{", "application/json", store, onSpan);
    expect(result.status).toBe(400);
    expect(store.getConversations()).toHaveLength(0);
    expect(onSpan).not.toHaveBeenCalled();
  });

  it("returns 400 when body exceeds 5MB", () => {
    const huge = "x".repeat(5 * 1024 * 1024 + 1);
    const result = processOtlpBody(huge, "application/json", store, onSpan);
    expect(result.status).toBe(400);
  });

  it("returns 415 when Content-Type is not application/json", () => {
    const body = JSON.stringify(makeEnvelope("t1", "s1"));
    const result = processOtlpBody(body, "application/x-protobuf", store, onSpan);
    expect(result.status).toBe(415);
    expect(onSpan).not.toHaveBeenCalled();
  });

  it("returns 400 when envelope has no resourceSpans", () => {
    const body = JSON.stringify({ resourceSpans: [] });
    const result = processOtlpBody(body, "application/json", store, onSpan);
    expect(result.status).toBe(200);
    expect(store.getConversations()).toHaveLength(0);
  });

  it("handles multiple spans across multiple resourceSpans", () => {
    const envelope: OtlpEnvelope = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc-a" } }] },
          scopeSpans: [
            {
              spans: [
                { traceId: "t1", spanId: "s1", name: "a", startTimeUnixNano: "1", endTimeUnixNano: "2" },
                { traceId: "t1", spanId: "s2", name: "b", startTimeUnixNano: "1", endTimeUnixNano: "2", parentSpanId: "s1" },
              ],
            },
          ],
        },
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "svc-b" } }] },
          scopeSpans: [
            {
              spans: [
                { traceId: "t1", spanId: "s3", name: "c", startTimeUnixNano: "1", endTimeUnixNano: "2", parentSpanId: "s1" },
              ],
            },
          ],
        },
      ],
    };

    const result = processOtlpBody(JSON.stringify(envelope), "application/json", store, onSpan);
    expect(result.status).toBe(200);
    expect(onSpan).toHaveBeenCalledTimes(3);
    expect(store.getConversations()[0]?.spans).toHaveLength(3);
    expect(store.getConversations()[0]?.servicesSeen.has("svc-b")).toBe(true);
  });

  it("falls back to 'unknown' service name when service.name attribute is missing", () => {
    const envelope: OtlpEnvelope = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: "t1", spanId: "s1", name: "op", startTimeUnixNano: "1", endTimeUnixNano: "2" },
              ],
            },
          ],
        },
      ],
    };

    processOtlpBody(JSON.stringify(envelope), "application/json", store, onSpan);
    expect(onSpan).toHaveBeenCalledWith("t1", expect.anything(), "unknown");
  });
});
