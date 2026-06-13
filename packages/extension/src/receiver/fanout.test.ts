import { describe, it, expect, vi, beforeEach } from "vitest";
import { Fanout } from "./fanout.js";
import type { OtlpSpan } from "./otlp-types.js";

function makeSpan(spanId: string): OtlpSpan {
  return {
    traceId: "t1",
    spanId,
    name: "op",
    startTimeUnixNano: "1000",
    endTimeUnixNano: "2000",
  };
}

describe("Fanout", () => {
  let fanout: Fanout;
  const postMessage = vi.fn();

  beforeEach(() => {
    fanout = new Fanout();
    postMessage.mockReset();
  });

  it("posts appendSpan message to open panel immediately after webviewReady", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    const span = makeSpan("s1");
    fanout.broadcastSpan("t1", span, "svc-a");

    expect(postMessage).toHaveBeenCalledWith({
      command: "appendSpan",
      traceId: "t1",
      span,
      serviceName: "svc-a",
    });
  });

  it("buffers messages before webviewReady and flushes on ready", () => {
    fanout.setPanel({ webview: { postMessage } } as never);

    const span1 = makeSpan("s1");
    const span2 = makeSpan("s2");
    fanout.broadcastSpan("t1", span1, "svc");
    fanout.broadcastSpan("t1", span2, "svc");

    expect(postMessage).not.toHaveBeenCalled();

    fanout.onWebviewReady();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: "appendSpan", traceId: "t1", span: span1 }));
    expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ command: "appendSpan", traceId: "t1", span: span2 }));
  });

  it("does not post when no panel is set", () => {
    fanout.broadcastSpan("t1", makeSpan("s1"), "svc");
    fanout.onWebviewReady();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("does not crash when panel postMessage throws", () => {
    postMessage.mockImplementation(() => {
      throw new Error("panel closed");
    });
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    expect(() => fanout.broadcastSpan("t1", makeSpan("s1"), "svc")).not.toThrow();
  });

  it("posts traceComplete message", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.broadcastTraceComplete("t1");

    expect(postMessage).toHaveBeenCalledWith({ command: "traceComplete", traceId: "t1" });
  });

  it("resets buffer when panel is replaced", () => {
    const postMessage2 = vi.fn();

    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.broadcastSpan("t1", makeSpan("s1"), "svc");

    fanout.setPanel({ webview: { postMessage: postMessage2 } } as never);
    fanout.onWebviewReady();

    expect(postMessage).not.toHaveBeenCalled();
    expect(postMessage2).toHaveBeenCalledOnce();
  });
});
