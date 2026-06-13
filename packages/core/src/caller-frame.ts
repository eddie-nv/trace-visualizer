/**
 * Captures the first stack frame that originates outside the agentgraph and
 * OpenTelemetry packages (DESIGN §M8 R6). This identifies the user's call site
 * for `code.file.path`, `code.line.number`, `code.function.name` stamping.
 *
 * V8 caveats accepted in v1:
 * - Bundled paths are not source-map resolved — `code.file.path` may point to
 *   a compiled bundle rather than a source file.
 * - If the user bundles their app and agentgraph is inlined into the same
 *   output file, the SKIP_PATTERNS will not match those inlined frames and
 *   `code.*` attributes may point at shim internals instead of user code.
 * - AI-SDK native spans carry no code location (they do not flow through this shim).
 */
export interface CallerFrame {
  readonly file: string;
  readonly line: number;
  readonly fn: string;
}

// V8 named frame:     "    at FunctionName (file:line:col)"
// V8 anonymous frame: "    at file:line:col"
// V8 async named:     "    at async FunctionName (file:line:col)"
const NAMED_FRAME_RE = /^\s+at (?:async )?(.+?) \((.+):(\d+):\d+\)$/;
const ANON_FRAME_RE = /^\s+at (?:async )?(.+):(\d+):\d+$/;

// Frames to skip — covers both production (npm) and dev (source) paths.
const SKIP_PATTERNS: RegExp[] = [
  /@agentgraph\//,          // npm install path: node_modules/@agentgraph/core
  /\/packages\/core\//,     // dev source
  /\/packages\/sdk\//,      // dev source
  /\/packages\/register\//, // dev source
  /@opentelemetry\//,       // OpenTelemetry internals
  /\(node:/,                // node: built-ins, parenthesised: "at Foo (node:...)"
  /^\s+at node:/,           // node: built-ins, bare: "at node:events:..."
];

// Captured once at startup so every invocation avoids a process.cwd() syscall.
const PROJECT_ROOT: string | undefined = (() => {
  try {
    return typeof process !== "undefined" ? process.cwd() : undefined;
  } catch {
    return undefined;
  }
})();

/**
 * Returns the first external caller frame from an Error stack, or `undefined`
 * when no suitable frame is found or when the stack is unavailable.
 *
 * Accepts an optional `overrideStack` for testing with synthetic stacks.
 */
export function captureCallerFrame(overrideStack?: string): CallerFrame | undefined {
  let stack: string | undefined;
  try {
    stack = overrideStack ?? new Error().stack;
  } catch {
    return undefined;
  }
  if (!stack) {
    return undefined;
  }
  for (const line of stack.split("\n")) {
    if (!line.includes(" at ")) {
      continue;
    }
    if (SKIP_PATTERNS.some((p) => p.test(line))) {
      continue;
    }
    const named = NAMED_FRAME_RE.exec(line);
    if (named !== null) {
      return { fn: named[1]!, file: relativize(named[2]!), line: parseInt(named[3]!, 10) };
    }
    const anon = ANON_FRAME_RE.exec(line);
    if (anon !== null) {
      return { fn: "<anonymous>", file: relativize(anon[1]!), line: parseInt(anon[2]!, 10) };
    }
  }
  return undefined;
}

function relativize(file: string): string {
  if (PROJECT_ROOT !== undefined && file.startsWith(PROJECT_ROOT + "/")) {
    return file.slice(PROJECT_ROOT.length + 1);
  }
  return file;
}
