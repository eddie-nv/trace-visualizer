export const CSS_VARS = `
  :root {
    --tv-bg: var(--vscode-editor-background, #1e1e1e);
    --tv-surface: var(--vscode-editorWidget-background, #252526);
    --tv-border: var(--vscode-editorWidget-border, #454545);
    --tv-text: var(--vscode-editor-foreground, #d4d4d4);
    --tv-text-muted: var(--vscode-descriptionForeground, #888888);
    --tv-accent: var(--vscode-focusBorder, #007fd4);
    --tv-arrow-solid: var(--vscode-editor-foreground, #d4d4d4);
    --tv-arrow-dashed: var(--vscode-descriptionForeground, #888888);
    --tv-highlight: var(--vscode-list-activeSelectionBackground, #094771);
    --tv-fragment-fill: rgba(255, 200, 100, 0.05);
    --tv-fragment-border: rgba(255, 200, 100, 0.4);
    --tv-node-fill: var(--vscode-editorWidget-background, #252526);
    --tv-node-border: var(--vscode-editorWidget-border, #454545);
    --tv-header-fill: var(--vscode-sideBarSectionHeader-background, #2d2d2d);
    --tv-lifeline: var(--vscode-editorWidget-border, #454545);
    --tv-inferred-opacity: 0.85;
  }
`;

export function injectThemeVars(doc: Document): void {
  const existing = doc.getElementById("ag-theme-vars");
  if (existing !== null) return;
  const style = doc.createElement("style");
  style.id = "ag-theme-vars";
  style.textContent = CSS_VARS;
  doc.head.appendChild(style);
}
