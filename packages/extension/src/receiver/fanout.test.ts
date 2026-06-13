import { describe, it, expect, vi, beforeEach } from "vitest";
import { Fanout } from "./fanout.js";
import type { OtlpSpan } from "./otlp-types.js";

function makeSpan(spanId: string, traceId = "t1"): OtlpSpan {
  return {
    traceId,
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
    expect(postMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "appendSpan", traceId: "t1", span: span1 }),
    );
    expect(postMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "appendSpan", traceId: "t1", span: span2 }),
    );
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

  it("posts traceComplete for the active trace", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.broadcastSpan("t1", makeSpan("s1"), "svc"); // activates t1
    fanout.broadcastTraceComplete("t1");

    expect(postMessage).toHaveBeenCalledWith({ command: "traceComplete", traceId: "t1" });
  });

  it("drops traceComplete for non-active trace", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.broadcastSpan("t1", makeSpan("s1"), "svc"); // activates t1
    fanout.broadcastTraceComplete("t2"); // t2 not active → dropped

    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "traceComplete" }),
    );
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

  it("drops broadcastSpan for non-active trace", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.broadcastSpan("t1", makeSpan("s1"), "svc"); // activates t1
    fanout.broadcastSpan("t2", makeSpan("s2", "t2"), "svc"); // t2 not active → dropped

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ traceId: "t1" }));
  });

  it("activateTrace clears buffer, sets active trace, and sends initTrace", () => {
    fanout.setPanel({ webview: { postMessage } } as never);

    // Buffer a span for t1
    fanout.broadcastSpan("t1", makeSpan("s1"), "svc");

    const spans = [{ span: makeSpan("s2", "t2"), serviceName: "svc" }];
    fanout.activateTrace("t2", spans, false);
    fanout.onWebviewReady();

    // Buffer was cleared — only initTrace for t2 should arrive
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ command: "initTrace", traceId: "t2", spans });
  });

  it("activateTrace sends traceComplete when complete=true", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    const spans = [{ span: makeSpan("s1"), serviceName: "svc" }];
    fanout.activateTrace("t1", spans, true);

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenNthCalledWith(1, { command: "initTrace", traceId: "t1", spans });
    expect(postMessage).toHaveBeenNthCalledWith(2, { command: "traceComplete", traceId: "t1" });
  });

  it("broadcastThemeChange sends themeChange message", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.broadcastThemeChange("dark");

    expect(postMessage).toHaveBeenCalledWith({ command: "themeChange", kind: "dark" });
  });

  it("subsequent broadcastSpan for new active trace is sent after activateTrace", () => {
    fanout.setPanel({ webview: { postMessage } } as never);
    fanout.onWebviewReady();

    fanout.activateTrace("t2", [], false);
    fanout.broadcastSpan("t2", makeSpan("s1", "t2"), "svc");

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: "appendSpan", traceId: "t2" }),
    );
  });
});
