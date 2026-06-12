/**
 * Tests A + C harness (M7, DESIGN §6). One entry (`npm run test:ac`):
 *
 * Test A-lite — runs the AI-SDK-native app's weather turn (native v6
 * telemetry, direct provider against the deterministic mock — the
 * vercel/ai-chatbot + AI Gateway leg is pending credentials), asserts the
 * documented span tree, and exports the trace as
 * `research/fixtures/test-a-reference.json`.
 *
 * Test C — runs one bare-app preload leg (our shim's spans), then applies
 * the committed query contract (`@agentgraph/core` isLLMCall/provider/usage)
 * to BOTH Jaeger result sets via the same code path: it must select exactly
 * the LLM spans in each (zero false positives) and return well-formed
 * provider/usage values for every selected span.
 *
 * Requires `npm run build` and a reachable Jaeger (`npm run jaeger:up`).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLLMCall, provider, usage } from "@agentgraph/core";
import { assertTestATree, TEST_A_EXPECTED_SPANS } from "../test-a/assert.ts";
import {
  fetchTraceJson,
  isJaegerReachable,
  JAEGER_QUERY_URL,
  tagRecord,
  waitForSpans,
  type JaegerSpan,
} from "../test-b/jaeger.ts";
import { MOCK_USAGE, startMockAnthropic } from "../test-b/mock-anthropic.ts";
import { MODEL, runLeg, SPANS_PER_LEG } from "../test-b/server-leg.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTER_DIST = fileURLToPath(
  new URL("../../packages/register/dist/index.js", import.meta.url),
);
const FIXTURE_PATH = fileURLToPath(
  new URL("../../research/fixtures/test-a-reference.json", import.meta.url),
);
const TURN_SCRIPT = "scripts/test-a/run-turn.ts";
const TURN_TIMEOUT_MS = 60_000;
const BARE_LEG_PORT = 18799;

interface Evidence {
  readonly criterion: string;
  readonly detail: string;
}

/** The turn runs as a subprocess (own global OTel state) and must be spawned
 * async: the mock server lives in THIS process, so a sync wait would
 * deadlock the event loop the mock needs to answer the SDK's requests. */
function runTurnSubprocess(mockOrigin: string, serviceName: string): Promise<void> {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !key.startsWith("AGENTGRAPH_"),
    ),
  ) as Record<string, string>;
  const child = spawn(process.execPath, [TURN_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...cleanEnv,
      TEST_A_MOCK_ORIGIN: mockOrigin,
      TEST_A_SERVICE: serviceName,
      ANTHROPIC_API_KEY: "mock-key",
      BARE_MODEL: MODEL,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`test-a turn timed out after ${TURN_TIMEOUT_MS}ms\n${stderr}`));
    }, TURN_TIMEOUT_MS);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`test-a turn exited with ${code ?? signal}\n${stderr}`));
      }
    });
  });
}

/** Test C selection check for one result set — the SAME code path for both. */
function assertContractSelection(
  setLabel: string,
  spans: readonly JaegerSpan[],
  expectedSpanIds: readonly string[],
): Evidence {
  const selected = spans.filter((span) => isLLMCall(tagRecord(span)));
  assert.deepEqual(
    [...selected.map((span) => span.spanID)].sort(),
    [...expectedSpanIds].sort(),
    `${setLabel}: isLLMCall must select exactly the LLM spans (got ${selected
      .map((span) => span.operationName)
      .join(", ")})`,
  );
  const providers = new Set<string>();
  for (const span of selected) {
    const attrs = tagRecord(span);
    const providerName = provider(attrs);
    assert.ok(
      providerName !== undefined,
      `${setLabel}/${span.operationName}: provider() returned undefined`,
    );
    providers.add(providerName);
    const tokens = usage(attrs);
    assert.equal(
      tokens.inputTokens,
      MOCK_USAGE.input_tokens,
      `${setLabel}/${span.operationName}: usage().inputTokens`,
    );
    assert.equal(
      tokens.outputTokens,
      MOCK_USAGE.output_tokens,
      `${setLabel}/${span.operationName}: usage().outputTokens`,
    );
  }
  return {
    criterion: `C: contract on set ${setLabel}`,
    detail: `${selected.length}/${spans.length} spans selected, zero false positives; provider=${[...providers].join(",")}; usage=${MOCK_USAGE.input_tokens}/${MOCK_USAGE.output_tokens} on every span`,
  };
}

function writeFixture(traceJson: unknown): void {
  const aiSdkVersion = readAiSdkVersion();
  const fixture = {
    _provenance: {
      generatedAt: new Date().toISOString(),
      source: "scripts/test-c/run.ts (M7 Test A-lite)",
      note:
        "Native AI SDK v6 telemetry from a direct streamText weather turn against the deterministic Anthropic mock. " +
        "The documented Test A recipe (vercel/ai-chatbot + @vercel/otel + AI Gateway) is pending gateway credentials — " +
        "re-export this fixture from the real app when they are available (DESIGN §6 Test A).",
      aiSdkVersion,
      runtime: `node ${process.version}`,
    },
    trace: traceJson,
  };
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
}

function readAiSdkVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(`${REPO_ROOT}node_modules/ai/package.json`, "utf8"),
    ) as Record<string, unknown>;
    return typeof pkg["version"] === "string" ? pkg["version"] : "unknown";
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  if (!existsSync(REGISTER_DIST)) {
    throw new Error("packages/register/dist is missing — run `npm run build` first");
  }
  if (!(await isJaegerReachable())) {
    throw new Error(`Jaeger not reachable at ${JAEGER_QUERY_URL} — run \`npm run jaeger:up\``);
  }
  const mock = await startMockAnthropic();
  try {
    const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
    const evidence: Evidence[] = [];

    // ---- Test A-lite: native AI SDK telemetry ----
    const taService = `ta-${runId}`;
    console.log(`Test A-lite: running the weather turn (service ${taService})…`);
    await runTurnSubprocess(mock.origin, taService);
    const aSpans = await waitForSpans(taService, TEST_A_EXPECTED_SPANS);
    const tree = assertTestATree(aSpans);
    evidence.push({
      criterion: "A: span tree",
      detail: `root ai.streamText + 2 doStream steps + ai.toolCall(getWeather) with correct parenting and timestamps (trace ${tree.traceId})`,
    });

    // ---- shim leg: our spans for the same prompt shape ----
    console.log("Test C: running the bare-app preload leg…");
    const bare = await runLeg({
      label: "tc-bare",
      runtime: "node",
      preload: true,
      port: BARE_LEG_PORT,
      mockOrigin: mock.origin,
      serviceName: `tc-bare-${runId}`,
    });
    assert.equal(bare.spans.length, SPANS_PER_LEG, "bare leg span count");

    // ---- Test C: one code path over both result sets ----
    evidence.push(
      assertContractSelection(
        "A (AI SDK native)",
        aSpans,
        tree.doStreams.map((span) => span.spanID),
      ),
    );
    evidence.push(
      assertContractSelection(
        "B (agentgraph shim)",
        bare.spans,
        bare.spans.map((span) => span.spanID),
      ),
    );

    // ---- fixture export ----
    writeFixture(await fetchTraceJson(tree.traceId));
    evidence.push({
      criterion: "A: fixture",
      detail: `trace ${tree.traceId} exported to research/fixtures/test-a-reference.json (provenance: A-lite, gateway leg pending credentials)`,
    });

    console.log("\nTests A + C (DESIGN §6) — evidence:");
    for (const item of evidence) {
      console.log(`  PASS ${item.criterion} — ${item.detail}`);
    }
    console.log("\nTests A + C PASS: contract holds across both sources via one code path");
  } finally {
    await mock.close();
  }
}

main().catch((error: unknown) => {
  console.error(`\nTests A + C FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
