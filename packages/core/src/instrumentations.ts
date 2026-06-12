/**
 * Tier-3 instrumentation classes (DESIGN §3 tier 3): `InstrumentationBase`
 * module definitions over the same prototype patching as
 * `manuallyInstrument`. Never enabled by default — only the register preload
 * activates them, behind `AGENTGRAPH_INSTRUMENT_SDKS=true`. The
 * `manuallyInstrument` methods are the loader-hook-free path (the documented
 * Next.js/webpack workaround) and also work under Bun.
 */
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  type InstrumentationConfig,
} from "@opentelemetry/instrumentation";
import type { CoreConfig } from "./content-gating.js";
import { manuallyInstrument, uninstrumentModule } from "./manually-instrument.js";

const INSTRUMENTATION_VERSION = "0.0.0";

/** Wire-format coverage, not class-layout coverage: the supported range is
 * deliberately wide — the patch degrades to a warn on unexpected shapes. */
const ANTHROPIC_VERSIONS = [">=0.30.0"];
const OPENAI_VERSIONS = [">=4"];

export type SdkInstrumentationConfig = InstrumentationConfig & CoreConfig;

export class AnthropicInstrumentation extends InstrumentationBase<SdkInstrumentationConfig> {
  constructor(config: SdkInstrumentationConfig = {}) {
    super("@agentgraph/instrumentation-anthropic", INSTRUMENTATION_VERSION, config);
  }

  protected init(): InstrumentationNodeModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "@anthropic-ai/sdk",
      ANTHROPIC_VERSIONS,
      (moduleExports: unknown) => {
        manuallyInstrument("anthropic", moduleExports, this.getConfig());
        return moduleExports;
      },
      (moduleExports: unknown) => {
        uninstrumentModule("anthropic", moduleExports);
        return moduleExports;
      },
    );
  }

  /** Tier-2 escape hatch: patch an already-imported module, no loader hooks. */
  manuallyInstrument(module: unknown): void {
    manuallyInstrument("anthropic", module, this.getConfig());
  }
}

export class OpenAIInstrumentation extends InstrumentationBase<SdkInstrumentationConfig> {
  constructor(config: SdkInstrumentationConfig = {}) {
    super("@agentgraph/instrumentation-openai", INSTRUMENTATION_VERSION, config);
  }

  protected init(): InstrumentationNodeModuleDefinition {
    return new InstrumentationNodeModuleDefinition(
      "openai",
      OPENAI_VERSIONS,
      (moduleExports: unknown) => {
        manuallyInstrument("openai", moduleExports, this.getConfig());
        return moduleExports;
      },
      (moduleExports: unknown) => {
        uninstrumentModule("openai", moduleExports);
        return moduleExports;
      },
    );
  }

  /** Tier-2 escape hatch: patch an already-imported module, no loader hooks. */
  manuallyInstrument(module: unknown): void {
    manuallyInstrument("openai", module, this.getConfig());
  }
}
