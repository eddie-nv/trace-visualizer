import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/webview/messages.js";

declare const acquireVsCodeApi: () => {
  postMessage(msg: WebviewToHostMessage): void;
};

const vscodeApi = acquireVsCodeApi();
const diagram = document.getElementById("diagram");

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.command) {
    case "initTrace":
      renderInit(msg.traceId, msg.spans);
      break;
    case "appendSpan":
      appendSpanRow(msg.traceId, msg.span.name, msg.span.spanId);
      break;
    case "traceComplete":
      appendLine(`[${msg.traceId}] trace complete`);
      break;
  }
});

vscodeApi.postMessage({ command: "webviewReady" });

function renderInit(
  traceId: string,
  spans: ReadonlyArray<{ span: { name: string; spanId: string }; serviceName: string }>,
): void {
  if (diagram) diagram.innerHTML = "";
  appendLine(`=== trace ${traceId} ===`);
  for (const { span, serviceName } of spans) {
    appendSpanRow(traceId, span.name, span.spanId, serviceName);
  }
}

function appendSpanRow(traceId: string, name: string, spanId: string, service?: string): void {
  const svc = service ? ` [${service}]` : "";
  appendLine(`${traceId.slice(0, 8)} | ${name}${svc} (${spanId.slice(0, 8)})`);
}

function appendLine(text: string): void {
  if (!diagram) return;
  const pre = diagram.querySelector("pre") ?? (() => {
    const p = document.createElement("pre");
    diagram.appendChild(p);
    return p;
  })();
  pre.textContent = (pre.textContent ?? "") + text + "\n";
}
