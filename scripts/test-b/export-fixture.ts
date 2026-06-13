/**
 * Exports the Test B reference fixture for the graph-layer research (Phase 1C
 * of the visualizer plan): runs ONE node-preload leg of the bare app against
 * the deterministic Anthropic mock, then saves the resulting Jaeger trace
 * JSON (both endpoints: /chat and /chat-stream) to
 * `research/fixtures/test-b-reference.json` — the same provenance pattern as
 * the Test A fixture exported by scripts/test-c/run.ts.
 *
 * Requires `npm run build` and a reachable Jaeger (`npm run jaeger:up`).
 * Run: `node scripts/test-b/export-fixture.ts`
 */
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchTraceJson, isJaegerReachable, JAEGER_QUERY_URL } from "./jaeger.ts";
import { startMockAnthropic } from "./mock-anthropic.ts";
import { runLeg } from "./server-leg.ts";

const REGISTER_DIST = fileURLToPath(
  new URL("../../packages/register/dist/index.js", import.meta.url),
);
const FIXTURE_PATH = fileURLToPath(
  new URL("../../research/fixtures/test-b-reference.json", import.meta.url),
);
const PORT = 18981;

interface TraceExport {
  readonly endpoint: "/chat" | "/chat-stream";
  readonly traceId: string;
  readonly trace: unknown;
}

async function main(): Promise<void> {
  if (!existsSync(REGISTER_DIST)) {
    throw new Error("packages/register/dist is missing — run `npm run build` first");
  }
  if (!(await isJaegerReachable())) {
    throw new Error(`Jaeger not reachable at ${JAEGER_QUERY_URL} — run \`npm run jaeger:up\``);
  }

  const mock = await startMockAnthropic();
  const runId = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const serviceName = `tb-fixture-${runId}`;
  try {
    const leg = await runLeg({
      label: "node-preload-fixture",
      runtime: "node",
      port: PORT,
      mockOrigin: mock.origin,
      preload: true,
      serviceName,
    });

    // One span per endpoint; each is the root of its own trace. Identify the
    // endpoints by the span's url.path / http.route style attribute being
    // unavailable here — instead match on span order via startTime (the leg
    // POSTs /chat before /chat-stream) and record both trace IDs.
    const ordered = [...leg.spans].sort((a, b) => a.startTime - b.startTime);
    const traceIds = [...new Set(ordered.map((span) => span.traceID))];
    const endpoints = ["/chat", "/chat-stream"] as const;
    if (traceIds.length !== endpoints.length) {
      throw new Error(
        `expected ${endpoints.length} traces (one per endpoint), got ${traceIds.length}`,
      );
    }
    const traces: TraceExport[] = [];
    for (const [index, traceId] of traceIds.entries()) {
      const endpoint = endpoints[index];
      if (endpoint === undefined) {
        throw new Error(`no endpoint label for trace index ${index}`);
      }
      traces.push({ endpoint, traceId, trace: await fetchTraceJson(traceId) });
    }

    const fixture = {
      _provenance: {
        generatedAt: new Date().toISOString(),
        source: "scripts/test-b/export-fixture.ts",
        note:
          "Zero-telemetry bare app (test-apps/bare/server.ts) under the @agentgraph/register " +
          "preload (tier-1 fetch hook), node runtime, against the deterministic Anthropic mock. " +
          "One trace per endpoint: /chat (non-streaming) and /chat-stream (SSE). " +
          "Graph-layer research input (visualizer plan Phase 1C).",
        runtime: `node ${process.version}`,
        serviceName,
      },
      traces,
    };
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(
      `exported ${traces.map((t) => `${t.endpoint}=${t.traceId}`).join(", ")} to ${FIXTURE_PATH}`,
    );
  } finally {
    await mock.close();
  }
}

main().catch((error: unknown) => {
  console.error(`export-fixture FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
