import { describe, expect, it } from "vitest";
import { captureCallerFrame, type CallerFrame } from "./caller-frame.js";

// Synthetic stacks use /proj/ as a stand-in project root so tests are
// path-independent. The relativize() helper only strips the real process.cwd().
const agentgraphLine = "    at startLLMSpan (/proj/packages/core/src/span-lifecycle.ts:30:5)";
const otelLine = "    at wrap (/proj/node_modules/@opentelemetry/api/build/src/context.js:10:5)";
const nodeBuiltinParen = "    at async Function.all (node:internal/promise_internals:107:5)";
const nodeBuiltinBare = "    at node:events:520:12";

function makeStack(...frames: string[]): string {
  return ["Error", ...frames].join("\n");
}

describe("captureCallerFrame", () => {
  it("returns the first non-internal named frame from a synthetic V8 stack", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      "    at myFunction (/proj/src/app.ts:42:5)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame).toEqual<CallerFrame>({ fn: "myFunction", file: "/proj/src/app.ts", line: 42 });
  });

  it("skips multiple agentgraph and OTel frames before reaching user code", () => {
    // Arrange
    const stack = makeStack(
      "    at captureCallerFrame (/proj/packages/core/src/caller-frame.ts:10:5)",
      agentgraphLine,
      otelLine,
      "    at userHandler (/proj/src/handler.ts:99:3)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("userHandler");
    expect(frame?.file).toBe("/proj/src/handler.ts");
    expect(frame?.line).toBe(99);
  });

  it("skips @opentelemetry frames", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      otelLine,
      "    at userCall (/proj/src/index.ts:5:5)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("userCall");
    expect(frame?.file).toBe("/proj/src/index.ts");
  });

  it("skips parenthesised node: built-in frames", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      nodeBuiltinParen,
      "    at userCode (/proj/src/handler.ts:10:5)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("userCode");
  });

  it("skips bare node: built-in frames (no parentheses)", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      nodeBuiltinBare,
      "    at userCode (/proj/src/app.ts:7:1)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("userCode");
  });

  it("returns undefined when every frame is internal", () => {
    // Arrange
    const stack = makeStack(
      "    at captureCallerFrame (/proj/packages/core/src/caller-frame.ts:10:5)",
      agentgraphLine,
    );

    // Act / Assert
    expect(captureCallerFrame(stack)).toBeUndefined();
  });

  it("handles anonymous frames (no function name parentheses)", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      "    at /proj/packages/core/src/fetch-hook.ts:100:5",
      "    at /proj/src/app.ts:15:3",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame).toEqual<CallerFrame>({ fn: "<anonymous>", file: "/proj/src/app.ts", line: 15 });
  });

  it("handles async anonymous frames (async prefix before path)", () => {
    // Arrange
    const stack = makeStack(
      agentgraphLine,
      "    at async /proj/src/routes.ts:55:10",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("<anonymous>");
    expect(frame?.file).toBe("/proj/src/routes.ts");
    expect(frame?.line).toBe(55);
  });

  it("returns undefined when stack is empty", () => {
    expect(captureCallerFrame("")).toBeUndefined();
  });

  it("returns undefined when stack has no parseable at-frames", () => {
    expect(captureCallerFrame("Error: something went wrong\n  caused by: bad config")).toBeUndefined();
  });

  it("relativizes absolute paths that start with process.cwd()", () => {
    // Arrange — synthetic frame whose path starts with the real project root
    const cwd = process.cwd();
    const stack = makeStack(
      agentgraphLine,
      `    at myFunc (${cwd}/src/app.ts:10:5)`,
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert — cwd prefix is stripped so the path is project-relative
    expect(frame?.file).toBe("src/app.ts");
  });

  it("uses sdk and register source paths as skip patterns", () => {
    // Arrange — ensure the other two dev-source package paths are also skipped
    const stack = makeStack(
      "    at init (/proj/packages/sdk/src/index.ts:10:5)",
      "    at doRegister (/proj/packages/register/src/register.ts:5:5)",
      "    at userEntry (/proj/src/server.ts:1:1)",
    );

    // Act
    const frame = captureCallerFrame(stack);

    // Assert
    expect(frame?.fn).toBe("userEntry");
  });
});
