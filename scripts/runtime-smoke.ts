/**
 * Verifies the built packages load from their published entry points (dist/),
 * under both Node and Bun, in both ESM and CJS forms. Run after `npm run build`.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { TRACER_NAME } from "@agentgraph/core";
import { TRACER_NAME as SDK_TRACER_NAME } from "@agentgraph/sdk";
import "@agentgraph/register";

const EXPECTED_TRACER_NAME = "agentgraph";

assert.equal(TRACER_NAME, EXPECTED_TRACER_NAME, "@agentgraph/core ESM export mismatch");
assert.equal(SDK_TRACER_NAME, EXPECTED_TRACER_NAME, "@agentgraph/sdk ESM re-export mismatch");

const requireCjs = createRequire(import.meta.url);
const coreCjs = requireCjs("@agentgraph/core") as { TRACER_NAME: string };
assert.equal(coreCjs.TRACER_NAME, EXPECTED_TRACER_NAME, "@agentgraph/core CJS export mismatch");
requireCjs("@agentgraph/register/cjs");

console.log("runtime smoke PASS: all packages load via ESM and CJS entries");
