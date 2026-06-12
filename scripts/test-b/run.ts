/**
 * Test B — bare-app verification harness (DESIGN §6, M5). Runs the zero-OTel
 * bare app in six legs (runtime × preload × content toggle × one-line tier)
 * against a deterministic local Anthropic mock, then asserts the five pass
 * criteria via the Jaeger query API:
 *
 *   1. span attributes on both endpoints
 *   2. streaming usage == non-streaming usage
 *   3. AGENTGRAPH_TRACE_CONTENT=false removes exactly the content attrs
 *   4. responses byte-identical with/without the preload (Node AND Bun)
 *   5. Bun leg green — the empirical answer to Q1/Q2
 *
 * Requires `npm run build` (preload resolves @agentgraph/register/dist) and a
 * reachable Jaeger (`npm run jaeger:up`). Runs the Node legs and the Bun legs
 * from one entry: `npm run test:b`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  assertAgentId,
  assertByteIdentity,
  assertContentRemoved,
  assertSpanAttributes,
  assertUsageParity,
  type Evidence,
} from "./criteria.ts";
import { isJaegerReachable, JAEGER_QUERY_URL } from "./jaeger.ts";
import { startMockAnthropic } from "./mock-anthropic.ts";
import { runLeg, type LegResult } from "./server-leg.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTER_DIST = fileURLToPath(
  new URL("../../packages/register/dist/index.js", import.meta.url),
);
const BASE_PORT = 18791;
const ONE_LINE_AGENT_ID = "test-agent";
const CONTEXT_PROBE = "scripts/test-b/q1-context-probe.ts";
const TIER3_PROBE = "scripts/test-b/tier3-probe.ts";
const PROBE_TIMEOUT_MS = 30_000;
const TIER2_AGENT_ID = "tier2-agent";

/** Q1's second half: context.with across async boundaries, per runtime. */
function runContextProbe(runtime: "node" | "bun"): Evidence {
  const command = runtime === "bun" ? "bun" : process.execPath;
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("AGENTGRAPH_"),
    ),
  ) as Record<string, string>;
  const result = spawnSync(command, [CONTEXT_PROBE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: cleanEnv,
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const spawnFailure = result.error === undefined ? "" : ` (${result.error.message})`;
    throw new Error(
      `q1 context probe failed under ${runtime} (status ${result.status})${spawnFailure}:\n${result.stderr}`,
    );
  }
  return { criterion: `Q1 context propagation (${runtime})`, detail: result.stdout.trim() };
}

/** M6 tier 3: real loader-hook interception of a post-init SDK import. Node-only. */
function runTier3Probe(): Evidence {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("AGENTGRAPH_"),
    ),
  ) as Record<string, string>;
  const result = spawnSync(process.execPath, [TIER3_PROBE], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...cleanEnv, AGENTGRAPH_INSTRUMENT_SDKS: "true" },
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    const spawnFailure = result.error === undefined ? "" : ` (${result.error.message})`;
    throw new Error(
      `tier-3 probe failed (status ${result.status})${spawnFailure}:\n${result.stderr}`,
    );
  }
  return { criterion: "M6 tier-3 module hooks (node)", detail: result.stdout.trim() };
}

async function preflight(): Promise<void> {
  if (!existsSync(REGISTER_DIST)) {
    throw new Error("packages/register/dist is missing — run `npm run build` first");
  }
  if (spawnSync("bun", ["--version"], { encoding: "utf8" }).status !== 0) {
    throw new Error("bun is not on PATH — the Bun leg (criterion 5, Q1/Q2) is mandatory");
  }
  if (!(await isJaegerReachable())) {
    throw new Error(`Jaeger not reachable at ${JAEGER_QUERY_URL} — run \`npm run jaeger:up\``);
  }
}

function printReport(evidence: readonly Evidence[]): void {
  console.log("\nTest B verification (DESIGN §6) — evidence:");
  for (const item of evidence) {
    console.log(`  PASS ${item.criterion} — ${item.detail}`);
  }
}

async function main(): Promise<void> {
  await preflight();
  const mock = await startMockAnthropic();
  // pid suffix: two runs in the same millisecond must not share Jaeger
  // service names, or waitForSpans could match the other run's spans.
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  try {
    const leg = (
      label: string,
      overrides: Partial<Parameters<typeof runLeg>[0]>,
      portOffset: number,
    ): Promise<LegResult> =>
      runLeg({
        label,
        runtime: "node",
        port: BASE_PORT + portOffset,
        mockOrigin: mock.origin,
        ...overrides,
      });

    console.log("Test B: running 8 legs against mock at", mock.origin);
    const nodeBaseline = await leg("node-baseline", {}, 0);
    const nodePreload = await leg(
      "node-preload",
      { preload: true, serviceName: `tb-node-${runId}` },
      1,
    );
    const nodeContentOff = await leg(
      "node-content-off",
      {
        preload: true,
        serviceName: `tb-nocontent-${runId}`,
        extraEnv: { AGENTGRAPH_TRACE_CONTENT: "false" },
      },
      2,
    );
    const bunBaseline = await leg("bun-baseline", { runtime: "bun" }, 3);
    const bunPreload = await leg(
      "bun-preload",
      { runtime: "bun", preload: true, serviceName: `tb-bun-${runId}` },
      4,
    );
    const oneLine = await leg(
      "node-one-line",
      { entry: "server-one-line.ts", serviceName: `tb-oneline-${runId}` },
      5,
    );
    // M6: tier-2 prototype patching with the tier-1 hook ALSO active — the
    // exact-2-span assertions below are the live §3.4 dedup gate.
    const tier2Node = await leg(
      "node-tier2",
      { entry: "server-tier2.ts", serviceName: `tb-tier2-node-${runId}` },
      6,
    );
    const tier2Bun = await leg(
      "bun-tier2",
      { runtime: "bun", entry: "server-tier2.ts", serviceName: `tb-tier2-bun-${runId}` },
      7,
    );

    const evidence: Evidence[] = [];
    evidence.push(assertSpanAttributes(nodePreload));
    evidence.push(assertUsageParity(nodePreload));
    evidence.push(assertContentRemoved(nodeContentOff));
    evidence.push(assertByteIdentity(nodeBaseline, nodePreload));
    // Criterion 5: the same attribute + parity gates, on Bun. Green means the
    // fetch hook, ALS context manager, and OTLP proto exporter all work under
    // Bun (Q1) and the SDK's requests hit globalThis.fetch (Q2).
    const bunAttributes = assertSpanAttributes(bunPreload);
    const bunParity = assertUsageParity(bunPreload);
    evidence.push({
      criterion: "5: Bun leg (answers Q1/Q2)",
      detail: `Bun ${bunVersion()} — ${bunAttributes.detail}; ${bunParity.detail}`,
    });
    evidence.push(assertByteIdentity(bunBaseline, bunPreload));
    evidence.push(assertSpanAttributes(oneLine));
    evidence.push(assertAgentId(oneLine, ONE_LINE_AGENT_ID));
    // M6 tier 2: attribute + parity asserts include the exact-2-span count,
    // so a dedup failure (4 spans) or a lost span (1) both fail loudly.
    const tier2NodeAttrs = assertSpanAttributes(tier2Node);
    assertUsageParity(tier2Node);
    evidence.push({
      criterion: "M6 tier-2 dedup (node)",
      detail: `${tier2NodeAttrs.detail}; exactly one span per call with BOTH tiers active`,
    });
    evidence.push(assertByteIdentity(nodeBaseline, tier2Node));
    evidence.push(assertAgentId(tier2Node, TIER2_AGENT_ID));
    const tier2BunAttrs = assertSpanAttributes(tier2Bun);
    assertUsageParity(tier2Bun);
    evidence.push({
      criterion: "M6 tier-2 dedup (bun)",
      detail: `${tier2BunAttrs.detail}; prototype patching + dedup hold under Bun ${bunVersion()}`,
    });
    evidence.push(assertByteIdentity(bunBaseline, tier2Bun));
    evidence.push(runTier3Probe());
    evidence.push(runContextProbe("node"));
    evidence.push(runContextProbe("bun"));

    printReport(evidence);
    console.log("\nTest B PASS: all 5 criteria green on Node and Bun");
  } finally {
    await mock.close();
  }
}

function bunVersion(): string {
  return spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim();
}

main().catch((error: unknown) => {
  console.error(`\nTest B FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
