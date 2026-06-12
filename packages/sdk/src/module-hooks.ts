/**
 * Tier-3 activation (DESIGN §3 tier 3): module-load interception, gated
 * behind `AGENTGRAPH_INSTRUMENT_SDKS=true` and never on by default. The ESM
 * loader hook (`module.register` + import-in-the-middle) is the documented
 * fragile layer (FINDINGS F1–F5), so every step is Sentry-style
 * try/catch-warn — a failure degrades to tier 1, never crashes the host.
 */
import Module from "node:module";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { AnthropicInstrumentation, OpenAIInstrumentation, type CoreConfig } from "@agentgraph/core";

const ESM_LOADER_HOOK = "import-in-the-middle/hook.mjs";

type RegisterFn = (specifier: string, parentURL: string | URL) => void;

/** `module.register` landed in Node 20.6; Bun and older Nodes lack it. */
const nativeRegister: RegisterFn | null =
  typeof (Module as { register?: RegisterFn }).register === "function"
    ? (Module as { register: RegisterFn }).register.bind(Module)
    : null;

/** Injectable seams — production callers pass nothing. */
export interface Tier3Seams {
  /** `null` models a runtime without `module.register`. */
  registerFn?: RegisterFn | null;
  enableFn?: (instrumentations: Instrumentation[]) => void;
}

/**
 * Register the ESM loader hook (when available) and enable the SDK
 * instrumentations (CJS interception via require-in-the-middle works without
 * the loader hook). Returns false only when even instrumentation enabling
 * failed; never throws.
 */
export function activateTier3(config: CoreConfig, seams: Tier3Seams = {}): boolean {
  const { registerFn = nativeRegister, enableFn = defaultEnable } = seams;
  try {
    if (registerFn === null) {
      console.warn(
        "agentgraph: module.register is unavailable on this runtime; tier-3 ESM interception disabled (CJS interception still active)",
      );
    } else {
      try {
        registerFn(ESM_LOADER_HOOK, import.meta.url);
      } catch (error) {
        console.warn(
          `agentgraph: could not register the ESM loader hook (${describe(error)}); tier-3 ESM interception disabled (CJS interception still active)`,
        );
      }
    }
    enableFn([
      new AnthropicInstrumentation({ enabled: false, ...config }),
      new OpenAIInstrumentation({ enabled: false, ...config }),
    ]);
    return true;
  } catch (error) {
    console.warn(
      `agentgraph: tier-3 SDK instrumentation failed (${describe(error)}); continuing with tier 1 only`,
    );
    return false;
  }
}

function defaultEnable(instrumentations: Instrumentation[]): void {
  registerInstrumentations({ instrumentations });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
