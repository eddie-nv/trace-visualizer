import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFiles, mockShowTextDocument, mockShowErrorMessage, mockRevealRange } = vi.hoisted(
  () => ({
    mockFindFiles: vi.fn(),
    mockShowTextDocument: vi.fn(),
    mockShowErrorMessage: vi.fn(),
    mockRevealRange: vi.fn(),
  }),
);

const mockEditor = { revealRange: mockRevealRange };

vi.mock("vscode", () => ({
  workspace: { findFiles: mockFindFiles },
  window: {
    showTextDocument: mockShowTextDocument,
    showErrorMessage: mockShowErrorMessage,
  },
  ViewColumn: { Beside: 2 },
  Position: class {
    constructor(
      public line: number,
      public character: number,
    ) {}
  },
  Range: class {
    constructor(
      public start: { line: number; character: number },
      public end: { line: number; character: number },
    ) {}
  },
  TextEditorRevealType: { InCenter: 2 },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
}));

import { openSourceLocation } from "./source-locator.js";

describe("openSourceLocation", () => {
  beforeEach(() => {
    mockFindFiles.mockReset();
    mockShowTextDocument.mockReset();
    mockShowErrorMessage.mockReset();
    mockRevealRange.mockReset();
  });

  it("opens the file at the specified line when file is found", async () => {
    const uri = { fsPath: "/workspace/src/agent.ts" };
    mockFindFiles.mockResolvedValueOnce([uri]);
    mockShowTextDocument.mockResolvedValueOnce(mockEditor);

    await openSourceLocation("src/agent.ts", 42, "myFunction");

    expect(mockFindFiles).toHaveBeenCalledWith("**/src/agent.ts", "**/node_modules/**", 5);
    expect(mockShowTextDocument).toHaveBeenCalledWith(uri, { viewColumn: 2 });
    expect(mockRevealRange).toHaveBeenCalledOnce();
  });

  it("falls back to function name search when file is not found", async () => {
    mockFindFiles
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ fsPath: "/workspace/src/tool.ts" }]);
    mockShowTextDocument.mockResolvedValueOnce(mockEditor);

    await openSourceLocation("src/missing.ts", 10, "myFunction");

    expect(mockFindFiles).toHaveBeenCalledTimes(2);
    expect(mockFindFiles).toHaveBeenNthCalledWith(2, "**/*myFunction*", "**/node_modules/**", 5);
  });

  it("shows error notification when neither file nor function search finds anything", async () => {
    mockFindFiles.mockResolvedValue([]);

    await openSourceLocation("src/missing.ts", 10, "missingFn");

    expect(mockShowTextDocument).not.toHaveBeenCalled();
    expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining("src/missing.ts"));
  });

  it("is a no-op when file is undefined", async () => {
    await openSourceLocation(undefined, undefined, undefined);

    expect(mockFindFiles).not.toHaveBeenCalled();
    expect(mockShowTextDocument).not.toHaveBeenCalled();
    expect(mockShowErrorMessage).not.toHaveBeenCalled();
  });

  it("falls back to function search when file is undefined but fn is provided", async () => {
    mockFindFiles.mockResolvedValueOnce([{ fsPath: "/workspace/src/tool.ts" }]);
    mockShowTextDocument.mockResolvedValueOnce(mockEditor);

    await openSourceLocation(undefined, 5, "toolHandler");

    expect(mockFindFiles).toHaveBeenCalledWith("**/*toolHandler*", "**/node_modules/**", 5);
    expect(mockShowTextDocument).toHaveBeenCalled();
  });
});
