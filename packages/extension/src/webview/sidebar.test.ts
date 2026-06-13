import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => ({}));
import { TraceSidebarProvider } from "./sidebar.js";
import type { SpanStore, TracedConversation } from "../receiver/span-store.js";
import type { Fanout } from "../receiver/fanout.js";

function makeConv(overrides: Partial<TracedConversation> = {}): TracedConversation {
  return {
    traceId: "t1",
    rootSpan: undefined,
    spans: [],
    servicesSeen: new Set(["svc-a"]),
    complete: false,
    ...overrides,
  };
}

function makeStore(convs: TracedConversation[] = [], conv?: TracedConversation): Partial<SpanStore> {
  return {
    getConversations: vi.fn(() => convs),
    getConversation: vi.fn((id: string) => (conv?.traceId === id ? conv : undefined)),
  };
}

function makeFanout(): Partial<Fanout> {
  return { activateTrace: vi.fn() };
}

function makeWebviewView(postMessage = vi.fn()) {
  let handler: ((msg: unknown) => void) | undefined;
  const innerWebview = {
    options: {} as { enableScripts: boolean },
    postMessage,
    onDidReceiveMessage: vi.fn((fn: (msg: unknown) => void) => {
      handler = fn;
      return { dispose: vi.fn() };
    }),
    _html: "",
    get html() { return this._html; },
    set html(v: string) { this._html = v; },
  };
  const webviewView = { webview: innerWebview };
  return {
    webviewView,
    get html() { return innerWebview.html; },
    sendMessage: (msg: unknown) => handler?.(msg),
  };
}

describe("TraceSidebarProvider", () => {
  let store: Partial<SpanStore>;
  let fanout: Partial<Fanout>;
  let openDiagram: () => void;

  beforeEach(() => {
    store = makeStore();
    fanout = makeFanout();
    openDiagram = vi.fn() as () => void;
  });

  it("renders empty state when no traces", () => {
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    expect(view.html).toContain("No traces received yet");
  });

  it("renders trace items when conversations exist", () => {
    const conv = makeConv({ traceId: "abc123", rootSpan: { name: "my-op" } as never, servicesSeen: new Set(["svc-a", "svc-b"]), complete: true });
    store = makeStore([conv], conv);
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    expect(view.html).toContain("my-op");
    expect(view.html).toContain("2 svc");
    expect(view.html).toContain("abc123");
  });

  it("shows truncated traceId as name when no rootSpan", () => {
    const conv = makeConv({ traceId: "deadbeefcafe1234" });
    store = makeStore([conv], conv);
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    expect(view.html).toContain("deadbeef");
  });

  it("calls fanout.activateTrace and openDiagram on selectTrace message", () => {
    const conv = makeConv({ traceId: "t1", spans: [], complete: false });
    store = makeStore([conv], conv);
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    view.sendMessage({ command: "selectTrace", traceId: "t1" });

    expect(fanout.activateTrace).toHaveBeenCalledWith("t1", [], false);
    expect(openDiagram).toHaveBeenCalledOnce();
  });

  it("ignores selectTrace for unknown traceId", () => {
    store = makeStore([], undefined);
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    view.sendMessage({ command: "selectTrace", traceId: "missing" });

    expect(fanout.activateTrace).not.toHaveBeenCalled();
    expect(openDiagram).not.toHaveBeenCalled();
  });

  it("ignores unrecognized messages", () => {
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    view.sendMessage({ command: "unknown" });

    expect(fanout.activateTrace).not.toHaveBeenCalled();
  });

  it("refresh re-renders with updated store data", () => {
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    const firstHtml = view.html;

    const conv = makeConv({ rootSpan: { name: "updated-op" } as never });
    store.getConversations = vi.fn(() => [conv]);
    provider.refresh();

    expect(view.html).not.toBe(firstHtml);
    expect(view.html).toContain("updated-op");
  });

  it("refresh before resolveWebviewView is a no-op", () => {
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    expect(() => provider.refresh()).not.toThrow();
    expect(store.getConversations).not.toHaveBeenCalled();
  });

  it("escapes HTML in operation name to prevent XSS", () => {
    const conv = makeConv({ rootSpan: { name: '<script>alert(1)</script>' } as never });
    store = makeStore([conv], conv);
    const provider = new TraceSidebarProvider(store as SpanStore, fanout as Fanout, openDiagram);
    const view = makeWebviewView();
    provider.resolveWebviewView(view.webviewView as never);

    expect(view.html).not.toContain("<script>alert(1)</script>");
    expect(view.html).toContain("&lt;script&gt;");
  });
});
