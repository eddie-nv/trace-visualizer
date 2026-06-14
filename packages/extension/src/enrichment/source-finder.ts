import { relative } from "node:path";
import * as vscode from "vscode";
import type { SourceFile } from "./types.js";

const MAX_FILES_PER_SERVICE = 3;
const MAX_SOURCE_CHARS = 6_000;
const FIND_LIMIT = 5;
const EXCLUDE_PATTERN = "{**/node_modules/**,**/dist/**,**/*.d.ts}";

// Only allow simple identifiers — reject path traversal attempts via service.name.
const SAFE_SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;

export async function findSourceFiles(serviceNames: ReadonlySet<string>): Promise<SourceFile[]> {
  const results = await Promise.all([...serviceNames].map((name) => findForService(name)));
  return results.flat();
}

async function findForService(serviceName: string): Promise<SourceFile[]> {
  if (!SAFE_SERVICE_NAME.test(serviceName)) return [];

  const pattern = `**/${serviceName}/**/*.{ts,js,py}`;
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE_PATTERN, FIND_LIMIT);

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const files: SourceFile[] = [];
  for (const uri of uris.slice(0, MAX_FILES_PER_SERVICE)) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const raw = Buffer.from(bytes).toString("utf-8");
      const content =
        raw.length > MAX_SOURCE_CHARS ? raw.slice(0, MAX_SOURCE_CHARS) + "\n[...truncated]" : raw;
      const filePath = workspaceRoot ? relative(workspaceRoot, uri.fsPath) : uri.fsPath;
      files.push({ serviceName, path: filePath, content });
    } catch {
      // Skip unreadable files.
    }
  }
  return files;
}
