import { init } from "@agentgraph/sdk";

/**
 * Cross-copy handshake state stored on `globalThis.__AGENTGRAPH__` (DESIGN §1,
 * per Sentry's `GLOBAL_OBJ._sentryEsmLoaderHookRegistered`). The ESM entry and
 * the CJS twin are separate module instances, so module-level state cannot
 * dedupe them — only a true global can.
 */
export interface AgentGraphGlobalState {
  readonly registered?: boolean;
}

/** Anything that can carry the global flag — `globalThis` in production. */
export interface AgentGraphGlobalCarrier {
  __AGENTGRAPH__?: AgentGraphGlobalState;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface RegisterOptions {
  initFn?: () => void;
  globalObj?: AgentGraphGlobalCarrier;
}

/**
 * Idempotent, never-throwing registration: set the global flag, then run the
 * env-configured `sdk.init()`. The flag is set BEFORE init so that when init
 * fails (e.g. bad `AGENTGRAPH_ENDPOINT`), the twin entry in the same process
 * does not re-attempt and warn a second time — all failures collapse into a
 * single `console.warn`, and the host app is never crashed by the preload.
 */
export function register(options: RegisterOptions = {}): void {
  const { initFn = init, globalObj = globalThis as AgentGraphGlobalCarrier } = options;
  try {
    if (globalObj.__AGENTGRAPH__?.registered === true) {
      return;
    }
    globalObj.__AGENTGRAPH__ = { ...globalObj.__AGENTGRAPH__, registered: true };
    initFn();
  } catch (error) {
    warnRegistrationFailure(error);
  }
}

function warnRegistrationFailure(error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  try {
    // The raw error rides along as a second argument so Node/Bun print the
    // stack — in a preload there is no other diagnostic channel.
    console.warn(`agentgraph: preload registration failed; tracing is disabled (${detail})`, error);
  } catch {
    // console.warn itself was removed or replaced with a throwing stub;
    // absorbing is the only option that honors never-crash-the-host (DESIGN §1).
  }
}
