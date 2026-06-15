import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import type { InferredActionNode, InferredArrow } from "../store/view-model.js";

type OpenFileCallback = (file: string, line: number, fn?: string) => void;

let panelEl: HTMLDivElement | null = null;
let onOpenFile: OpenFileCallback | null = null;

export function initDetailPanel(container: HTMLElement, onOpen: OpenFileCallback): void {
  onOpenFile = onOpen;

  const panel = document.createElement("div");
  panel.id = "ag-detail-panel";
  panel.style.cssText = `
    position: absolute;
    top: 0;
    right: 0;
    width: 280px;
    height: 100%;
    background: var(--tv-surface);
    border-left: 1px solid var(--tv-border);
    overflow-y: auto;
    padding: 12px;
    box-sizing: border-box;
    font-family: var(--vscode-font-family, monospace);
    font-size: 12px;
    color: var(--tv-text);
    display: none;
  `;
  container.appendChild(panel);
  panelEl = panel;
}

export function showSpanDetail(span: OtlpSpan | undefined): void {
  if (panelEl === null || span === undefined) return;
  panelEl.style.display = "block";
  panelEl.innerHTML = buildPanelHTML(span);

  const openBtn = panelEl.querySelector<HTMLButtonElement>("#ag-open-file-btn");
  if (openBtn !== null && onOpenFile !== null) {
    const file = openBtn.dataset["file"];
    const line = Number(openBtn.dataset["line"]);
    const fn = openBtn.dataset["fn"];
    if (file !== undefined && !Number.isNaN(line)) {
      openBtn.addEventListener("click", () => onOpenFile!(file, line, fn));
    }
  }

  const closeBtn = panelEl.querySelector<HTMLButtonElement>("#ag-panel-close");
  closeBtn?.addEventListener("click", hideDetail);
}

export function hideDetail(): void {
  if (panelEl !== null) panelEl.style.display = "none";
}

export function showInferredDetail(
  node: InferredActionNode | InferredArrow,
  accentColor: string,
): void {
  if (panelEl === null) return;
  panelEl.style.display = "block";
  panelEl.innerHTML = buildInferredPanelHTML(node, accentColor);

  const openBtn = panelEl.querySelector<HTMLButtonElement>("#ag-open-file-btn");
  if (openBtn !== null && onOpenFile !== null) {
    const file = openBtn.dataset["file"];
    const line = Number(openBtn.dataset["line"]);
    if (file !== undefined && !Number.isNaN(line)) {
      openBtn.addEventListener("click", () => onOpenFile!(file, line, undefined));
    }
  }

  const closeBtn = panelEl.querySelector<HTMLButtonElement>("#ag-panel-close");
  closeBtn?.addEventListener("click", hideDetail);
}

function buildPanelHTML(span: OtlpSpan): string {
  const attrs = span.attributes ?? [];
  const file = attrs.find((a) => a.key === "code.file.path")?.value?.stringValue;
  const lineVal = attrs.find((a) => a.key === "code.line.number")?.value;
  const line = lineVal?.intValue !== undefined ? Number(lineVal.intValue) : undefined;
  const fn = attrs.find((a) => a.key === "code.function.name")?.value?.stringValue;

  const inputTokens = attrs.find((a) => a.key === "gen_ai.usage.input_tokens")?.value?.intValue;
  const outputTokens = attrs.find((a) => a.key === "gen_ai.usage.output_tokens")?.value?.intValue;
  const finishReasons = attrs.find((a) => a.key === "gen_ai.response.finish_reasons")?.value
    ?.stringValue;
  const model = attrs.find((a) => a.key === "gen_ai.request.model")?.value?.stringValue;

  let durationMs: bigint | undefined;
  try {
    durationMs = (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n;
  } catch {
    durationMs = undefined;
  }

  const openFileBtn =
    file !== undefined && line !== undefined
      ? `<button id="ag-open-file-btn"
           data-file="${escapeAttr(file)}"
           data-line="${line}"
           ${fn !== undefined ? `data-fn="${escapeAttr(fn)}"` : ""}
           style="margin-top:8px;padding:4px 8px;background:var(--tv-accent);color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;">
           Open in editor
         </button>`
      : "";

  const tokenRow =
    inputTokens !== undefined || outputTokens !== undefined
      ? `<tr><td style="color:var(--tv-text-muted)">tokens</td><td>${inputTokens ?? "?"} in / ${outputTokens ?? "?"} out</td></tr>`
      : "";

  return `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong style="font-size:13px">${escapeHtml(span.name)}</strong>
      <button id="ag-panel-close" style="background:none;border:none;color:var(--tv-text-muted);cursor:pointer;font-size:16px;padding:0 4px">×</button>
    </div>
    <table style="width:100%;border-collapse:collapse;font-size:11px">
      ${model !== undefined ? `<tr><td style="color:var(--tv-text-muted);padding:2px 4px">model</td><td style="padding:2px 4px">${escapeHtml(model)}</td></tr>` : ""}
      ${durationMs !== undefined ? `<tr><td style="color:var(--tv-text-muted);padding:2px 4px">duration</td><td style="padding:2px 4px">${durationMs}ms</td></tr>` : ""}
      ${tokenRow}
      ${finishReasons !== undefined ? `<tr><td style="color:var(--tv-text-muted);padding:2px 4px">finish</td><td style="padding:2px 4px">${escapeHtml(finishReasons.replace(/["\[\]]/g, ""))}</td></tr>` : ""}
      ${file !== undefined ? `<tr><td style="color:var(--tv-text-muted);padding:2px 4px">file</td><td style="padding:2px 4px;word-break:break-all">${escapeHtml(file)}${line !== undefined ? `:${line}` : ""}</td></tr>` : ""}
    </table>
    ${openFileBtn}
  `;
}

function buildInferredPanelHTML(node: InferredActionNode | InferredArrow, accentColor: string): string {
  const { file, line, snippet } = node.codePointer;
  const fileDisplay = `${file.split("/").pop() ?? file}:${line}`;

  const snippetSection =
    snippet !== undefined
      ? `<pre style="margin:8px 0;padding:6px;background:var(--tv-surface-alt,#1e1e1e);border-radius:3px;font-size:10px;overflow-x:auto;color:var(--tv-text)">${escapeHtml(snippet)}</pre>`
      : "";

  return `
    <div id="ag-inferred-header" style="margin:-12px -12px 12px;padding:10px 12px;background:${escapeAttr(accentColor)};color:#fff;display:flex;justify-content:space-between;align-items:center">
      <strong style="font-size:13px">${escapeHtml(node.label)}</strong>
      <button id="ag-panel-close" style="background:none;border:none;color:rgba(255,255,255,0.8);cursor:pointer;font-size:16px;padding:0 4px">×</button>
    </div>
    <div style="margin-bottom:8px">
      <div style="color:var(--tv-text-muted);font-size:10px;text-transform:uppercase;margin-bottom:4px">Reasoning</div>
      <div style="font-size:11px">${escapeHtml(node.reasoning)}</div>
    </div>
    <div style="margin-bottom:4px">
      <div style="color:var(--tv-text-muted);font-size:10px;text-transform:uppercase;margin-bottom:2px">Code</div>
      <div style="font-size:11px;word-break:break-all">${escapeHtml(fileDisplay)}</div>
    </div>
    ${snippetSection}
    <button id="ag-open-file-btn"
      data-file="${escapeAttr(file)}"
      data-line="${line}"
      style="margin-top:8px;padding:4px 8px;background:${escapeAttr(accentColor)};color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:11px;">
      Open in editor
    </button>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
