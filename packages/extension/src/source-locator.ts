import * as vscode from "vscode";

const FIND_LIMIT = 5;
const EXCLUDE = "**/node_modules/**";

export async function openSourceLocation(
  file: string | undefined,
  line: number | undefined,
  fn: string | undefined,
): Promise<void> {
  if (!file && !fn) return;

  if (file) {
    const uris = await vscode.workspace.findFiles(`**/${file}`, EXCLUDE, FIND_LIMIT);
    if (uris.length > 0) {
      await revealInEditor(uris[0]!, line);
      return;
    }
  }

  if (fn) {
    const uris = await vscode.workspace.findFiles(`**/*${fn}*`, EXCLUDE, FIND_LIMIT);
    if (uris.length > 0) {
      await revealInEditor(uris[0]!, line);
      return;
    }
  }

  if (file) {
    vscode.window.showErrorMessage(`AgentGraph: could not find ${file} in workspace`);
  }
}

async function revealInEditor(uri: vscode.Uri, line: number | undefined): Promise<void> {
  const editor = await vscode.window.showTextDocument(uri, {
    viewColumn: vscode.ViewColumn.Beside,
  });
  const lineIndex = Math.max(0, (line ?? 1) - 1);
  const pos = new vscode.Position(lineIndex, 0);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
