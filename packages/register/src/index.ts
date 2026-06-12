/**
 * @agentgraph/register — side-effect-only preload entry for
 * `node --import`, `node --require` (via ./cjs), and `bun --preload`.
 *
 * Top-level side effect: env-configured `sdk.init()`, idempotent across the
 * ESM/CJS twins via `globalThis.__AGENTGRAPH__.registered`, never crashes the
 * host (DESIGN §1). Tier 1 only; `AGENTGRAPH_INSTRUMENT_SDKS=true` is reserved
 * for tier-3 module hooks (wired in M6).
 */
import { register } from "./register.js";

register();

export {};
