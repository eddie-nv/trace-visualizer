import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFiles, mockReadFile, mockWorkspaceFolders } = vi.hoisted(() => ({
  mockFindFiles: vi.fn(),
  mockReadFile: vi.fn(),
  mockWorkspaceFolders: [{ uri: { fsPath: "/workspace" } }],
}));

vi.mock("vscode", () => ({
  workspace: {
    findFiles: mockFindFiles,
    fs: { readFile: mockReadFile },
    workspaceFolders: mockWorkspaceFolders,
  },
}));

import { findSourceFiles } from "./source-finder.js";

const enc = new TextEncoder();

describe("findSourceFiles", () => {
  beforeEach(() => {
    mockFindFiles.mockReset();
    mockReadFile.mockReset();
  });

  it("returns empty array when no files found", async () => {
    mockFindFiles.mockResolvedValue([]);

    const result = await findSourceFiles(new Set(["agent-a"]));

    expect(result).toHaveLength(0);
  });

  it("returns SourceFile with workspace-relative path", async () => {
    const uri = { fsPath: "/workspace/agent-a/index.ts" };
    mockFindFiles.mockResolvedValue([uri]);
    mockReadFile.mockResolvedValue(enc.encode("const x = 1;"));

    const result = await findSourceFiles(new Set(["agent-a"]));

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      serviceName: "agent-a",
      path: "agent-a/index.ts", // relative, not absolute
      content: "const x = 1;",
    });
  });

  it("path does not contain workspace root (no absolute path leak)", async () => {
    const uri = { fsPath: "/workspace/agent-a/index.ts" };
    mockFindFiles.mockResolvedValue([uri]);
    mockReadFile.mockResolvedValue(enc.encode("code"));

    const result = await findSourceFiles(new Set(["agent-a"]));

    expect(result[0]!.path).not.toContain("/workspace");
  });

  it("truncates file content at MAX_SOURCE_CHARS and appends marker", async () => {
    const uri = { fsPath: "/workspace/agent-a/big.ts" };
    const bigContent = "x".repeat(7000);
    mockFindFiles.mockResolvedValue([uri]);
    mockReadFile.mockResolvedValue(enc.encode(bigContent));

    const result = await findSourceFiles(new Set(["agent-a"]));

    expect(result[0]!.content).toContain("[...truncated]");
    expect(result[0]!.content.length).toBeLessThan(7000);
  });

  it("does not append truncation marker when content is within limit", async () => {
    const uri = { fsPath: "/workspace/agent-a/small.ts" };
    mockFindFiles.mockResolvedValue([uri]);
    mockReadFile.mockResolvedValue(enc.encode("const x = 1;"));

    const result = await findSourceFiles(new Set(["agent-a"]));

    expect(result[0]!.content).not.toContain("[...truncated]");
  });

  it("limits files to MAX_FILES_PER_SERVICE per service", async () => {
    const uris = Array.from({ length: 10 }, (_, i) => ({ fsPath: `/workspace/svc/file${i}.ts` }));
    mockFindFiles.mockResolvedValue(uris);
    mockReadFile.mockResolvedValue(enc.encode("code"));

    const result = await findSourceFiles(new Set(["svc"]));

    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("skips files that fail to read without crashing", async () => {
    const uris = [{ fsPath: "/workspace/svc/ok.ts" }, { fsPath: "/workspace/svc/bad.ts" }];
    mockFindFiles.mockResolvedValue(uris);
    mockReadFile
      .mockResolvedValueOnce(enc.encode("good code"))
      .mockRejectedValueOnce(new Error("permission denied"));

    const result = await findSourceFiles(new Set(["svc"]));

    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBe("good code");
  });

  it("returns files for multiple services", async () => {
    const uriA = { fsPath: "/workspace/agent-a/index.ts" };
    const uriB = { fsPath: "/workspace/agent-b/index.ts" };
    mockFindFiles.mockResolvedValueOnce([uriA]).mockResolvedValueOnce([uriB]);
    mockReadFile.mockResolvedValue(enc.encode("code"));

    const result = await findSourceFiles(new Set(["agent-a", "agent-b"]));

    const serviceNames = result.map((f) => f.serviceName);
    expect(serviceNames).toContain("agent-a");
    expect(serviceNames).toContain("agent-b");
  });

  it("rejects service names with path traversal characters", async () => {
    const result = await findSourceFiles(new Set(["../etc"]));

    expect(mockFindFiles).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it("rejects service names with forward slashes", async () => {
    const result = await findSourceFiles(new Set(["svc/../../etc"]));

    expect(mockFindFiles).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });

  it("accepts service names with hyphens and underscores", async () => {
    mockFindFiles.mockResolvedValue([]);

    await findSourceFiles(new Set(["agent_a-service"]));

    expect(mockFindFiles).toHaveBeenCalled();
  });
});
