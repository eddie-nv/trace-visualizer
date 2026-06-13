import type { HostToWebviewMessage, WebviewToHostMessage } from "../src/webview/messages.js";
import type { OtlpSpan } from "../src/receiver/otlp-types.js";
import type { ViewModel } from "./store/view-model.js";
import { TraceStore } from "./store/trace-store.js";
import { buildLayout } from "./layout/swimlane.js";
import type { SwimlaneLayout } from "./layout/swimlane.js";
import { injectThemeVars } from "./renderer/theme.js";
import { createScene } from "./renderer/scene.js";
import { renderColumns, renderFooterColumns, clearColumns } from "./renderer/columns.js";
import { renderArrows, renderSpanEvents, clearArrows } from "./renderer/arrows.js";
import { renderActionNodes, clearActionNodes } from "./renderer/action-nodes.js";
import { renderFragments, clearFragments } from "./renderer/fragments.js";
import { initDetailPanel, showSpanDetail, hideDetail } from "./renderer/detail-panel.js";

declare const acquireVsCodeApi: () => {
  postMessage(msg: WebviewToHostMessage): void;
};

const vscodeApi = acquireVsCodeApi();

injectThemeVars(document);

const diagramContainer = document.getElementById("diagram") as HTMLDivElement;
diagramContainer.style.position = "relative";
diagramContainer.style.width = "100%";
diagramContainer.style.height = "100%";
diagramContainer.style.overflow = "hidden";

const scene = createScene(diagramContainer);

const store = new TraceStore();
const spanIndex = new Map<string, OtlpSpan>();

let lastVm: ViewModel | undefined = undefined;
let lastLayout: SwimlaneLayout | undefined = undefined;

function buildRowMap(layout: SwimlaneLayout) {
  return new Map(layout.rows.map((r) => [r.id, r]));
}

function renderViewModel(vm: ViewModel): void {
  const layout = buildLayout(vm);
  lastVm = vm;
  lastLayout = layout;
  const rowMap = buildRowMap(layout);

  renderColumns(scene.lifelines, vm.participants, layout.columns, layout.totalHeight);
  renderArrows(scene.arrows, vm.arrows, layout.columns, rowMap, (spanId) => {
    const span = spanIndex.get(spanId);
    showSpanDetail(span);
    vscodeApi.postMessage({ command: "spanSelected", spanId });
  });
  renderSpanEvents(scene.arrows, vm.spanEvents, layout.columns, rowMap);
  renderActionNodes(scene.nodes, vm.actionNodes, layout.columns, rowMap, (spanId) => {
    const span = spanIndex.get(spanId);
    showSpanDetail(span);
    vscodeApi.postMessage({ command: "spanSelected", spanId });
  });
  renderFragments(scene.fragments, vm.fragments, layout.columns, rowMap);
}

function resetScene(): void {
  clearColumns();
  clearArrows();
  clearActionNodes();
  clearFragments();
  hideDetail();
  scene.lifelines.innerHTML = "";
  scene.arrows.innerHTML = "";
  scene.nodes.innerHTML = "";
  scene.fragments.innerHTML = "";
  lastVm = undefined;
  lastLayout = undefined;
}

store.subscribe(renderViewModel);

initDetailPanel(diagramContainer, (file, line, fn) => {
  vscodeApi.postMessage({ command: "openFile", file, line, fn });
});

window.addEventListener("message", (event: MessageEvent<HostToWebviewMessage>) => {
  const msg = event.data;
  switch (msg.command) {
    case "initTrace": {
      resetScene();
      spanIndex.clear();
      for (const { span } of msg.spans) {
        spanIndex.set(span.spanId, span);
      }
      store.setActiveTrace(msg.traceId, msg.spans);
      break;
    }
    case "appendSpan": {
      spanIndex.set(msg.span.spanId, msg.span);
      store.appendSpan(msg.traceId, msg.span, msg.serviceName);
      break;
    }
    case "traceComplete": {
      if (lastVm && lastLayout) {
        renderFooterColumns(scene.lifelines, lastVm.participants, lastLayout.columns, lastLayout.totalHeight);
      }
      break;
    }
    case "themeChange": {
      // VS Code automatically updates its CSS variables in the webview on theme change.
      // Our --tv-* vars reference those directly, so no explicit action is needed.
      break;
    }
  }
});

vscodeApi.postMessage({ command: "webviewReady" });
