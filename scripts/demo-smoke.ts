/**
 * End-to-end smoke test for the AgentGraph demo.
 *
 * Starts a lightweight OTLP/JSON receiver, launches all 3 demo services,
 * fires one request, and asserts:
 *   1. The orchestrator → agent-a → agent-b HTTP chain succeeded.
 *   2. Spans arrived from all 3 services.
 *   3. All spans share a single traceId (W3C propagation worked).
 *
 * Writes the collected trace to AGENTGRAPH_STORE_PATH (default
 * ~/.agentgraph/traces.json) in the same format the VS Code extension uses,
 * so MCP tools can query it immediately after the smoke run.
 *
 * Usage: node scripts/demo-smoke.ts
 * Exit:  0 on PASS, 1 on FAIL.
 */

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_START = path.resolve(__dirname, "../demo/start.ts");
const RECEIVER_PORT = 4320;
const ENDPOINT = `http://localhost:${RECEIVER_PORT}`;
const STORE_PATH =
  process.env["AGENTGRAPH_STORE_PATH"] ?? path.join(os.homedir(), ".agentgraph", "traces.json");
const READY_TIMEOUT_MS = 12_000;
const SPAN_DRAIN_MS = 2_000;

// ── types mirroring ipc-store.ts ─────────────────────────────────────────────

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string | number;
}
interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
}
interface SpanEntry {
  span: OtlpSpan;
  serviceName: string;
}

// ── OTLP receiver ─────────────────────────────────────────────────────────────

const collected: SpanEntry[] = [];

function startReceiver(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/traces") {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const ct = req.headers["content-type"] ?? "";
        if (!ct.includes("application/json")) {
          res.writeHead(415);
          res.end("Unsupported Media Type");
          return;
        }
        try {
          const envelope = JSON.parse(Buffer.concat(chunks).toString()) as {
            resourceSpans?: Array<{
              resource?: { attributes?: OtlpAttribute[] };
              scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
            }>;
          };
          for (const rs of envelope.resourceSpans ?? []) {
            const serviceName =
              rs.resource?.attributes?.find((a) => a.key === "service.name")?.value
                .stringValue ?? "unknown";
            for (const ss of rs.scopeSpans ?? []) {
              for (const span of ss.spans ?? []) {
                collected.push({ span, serviceName });
              }
            }
          }
        } catch {
          // malformed body — still return 200 so the exporter doesn't retry
        }
        res.writeHead(200);
        res.end("{}");
      });
    });
    server.listen(RECEIVER_PORT, () => resolve(server));
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

import { execSync } from "node:child_process";

/** Kill any process occupying a port (best-effort, macOS/Linux). */
function killPort(port: number): void {
  try {
    const pids = execSync(`lsof -t -i :${port}`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
    }
  } catch { /* lsof not available or port already free */ }
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, "127.0.0.1");
      sock.on("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error(`port ${port} not ready after ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    console.error(`FAIL  ${message}`);
    process.exit(1);
  }
}

function cleanup(proc: ChildProcess, server: http.Server): void {
  proc.kill();
  server.close();
}

// ── main ──────────────────────────────────────────────────────────────────────

console.log("demo-smoke: starting receiver on", ENDPOINT);
const receiver = await startReceiver();

console.log("demo-smoke: clearing demo ports (3001, 3002, 3003)");
for (const port of [3001, 3002, 3003]) killPort(port);
await new Promise<void>((r) => setTimeout(r, 300));

console.log("demo-smoke: launching demo services");
const demoProc = spawn("node", [DEMO_START], {
  env: {
    ...process.env,
    AGENTGRAPH_ENDPOINT: ENDPOINT,
    AGENTGRAPH_DISABLE_BATCH: "true",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
demoProc.stdout?.on("data", (d: Buffer) => process.stdout.write("  " + d.toString()));
demoProc.stderr?.on("data", (d: Buffer) => process.stderr.write("  " + d.toString()));

try {
  console.log("demo-smoke: waiting for services (3001, 3002, 3003)…");
  await Promise.all([3001, 3002, 3003].map((p) => waitForPort(p, READY_TIMEOUT_MS)));

  console.log("demo-smoke: sending POST /run {prompt:'smoke-test'}");
  const res = await fetch("http://localhost:3001/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "smoke-test" }),
  });

  assert(res.ok, `orchestrator returned HTTP ${res.status}`);

  const body = (await res.json()) as {
    ok: boolean;
    result?: { ok: boolean; tool?: { ok: boolean } };
  };

  assert(body.ok === true, "orchestrator ok:false");
  assert(body.result?.ok === true, "agent-a ok:false");
  assert(body.result?.tool?.ok === true, "agent-b ok:false");

  console.log(`demo-smoke: HTTP chain ✓ — draining spans (${SPAN_DRAIN_MS}ms)…`);
  await new Promise<void>((r) => setTimeout(r, SPAN_DRAIN_MS));

  // ── span assertions ──────────────────────────────────────────────────────

  const servicesSeen = new Set(collected.map((e) => e.serviceName));
  assert(servicesSeen.has("orchestrator"), "no spans from orchestrator");
  assert(servicesSeen.has("agent-a"), "no spans from agent-a");
  assert(servicesSeen.has("agent-b"), "no spans from agent-b");

  // Find the traceId that appears across all 3 services (W3C propagation check)
  const tracesByService = new Map<string, Set<string>>();
  for (const { span, serviceName } of collected) {
    if (!tracesByService.has(serviceName)) tracesByService.set(serviceName, new Set());
    tracesByService.get(serviceName)!.add(span.traceId);
  }
  const sharedTraceId = [...(tracesByService.get("orchestrator") ?? [])]
    .find((id) => tracesByService.get("agent-a")?.has(id) && tracesByService.get("agent-b")?.has(id));
  assert(sharedTraceId !== undefined, "no single traceId shared across all 3 services");

  // ── agentic loop span structure ──────────────────────────────────────────
  // Expected span tree with service wrapper spans:
  //   orchestrator.run  (SERVER, service=orchestrator)
  //     └─ agent-a.process  (SERVER, service=agent-a)
  //          └─ chat claude-opus-4-8  (CLIENT, turn 1)
  //               └─ agent-b.tool  (SERVER, service=agent-b)
  //                    └─ tool.web_search  (INTERNAL)
  //          └─ chat claude-opus-4-8  (CLIENT, turn 2)

  const traceSpans = collected.filter((e) => e.span.traceId === sharedTraceId);
  const spanById = new Map(traceSpans.map((e) => [e.span.spanId, e.span]));

  const orchestratorSpanEntry = traceSpans.find((e) => e.span.name === "orchestrator.run");
  assert(orchestratorSpanEntry !== undefined, "missing orchestrator.run span");

  const agentAProcessEntry = traceSpans.find((e) => e.span.name === "agent-a.process");
  assert(agentAProcessEntry !== undefined, "missing agent-a.process span");
  assert(
    agentAProcessEntry.span.parentSpanId === orchestratorSpanEntry.span.spanId,
    `agent-a.process parent should be orchestrator.run, got '${spanById.get(agentAProcessEntry.span.parentSpanId ?? "")?.name}'`,
  );

  const chatSpans = traceSpans.filter((e) => e.span.name === "chat claude-opus-4-8");
  assert(
    chatSpans.length >= 2,
    `expected ≥2 'chat claude-opus-4-8' spans (LLM turn 1 + turn 2), got ${chatSpans.length}`,
  );

  const chatChildrenOfAgentAProcess = chatSpans.filter(
    (e) => e.span.parentSpanId === agentAProcessEntry.span.spanId,
  );
  assert(
    chatChildrenOfAgentAProcess.length >= 2,
    `expected ≥2 'chat claude-opus-4-8' direct children of agent-a.process, got ${chatChildrenOfAgentAProcess.length}`,
  );

  const agentBToolEntry = traceSpans.find((e) => e.span.name === "agent-b.tool");
  assert(agentBToolEntry !== undefined, "missing agent-b.tool span");

  const toolSpanEntry = traceSpans.find((e) => e.span.name === "tool.web_search");
  assert(toolSpanEntry !== undefined, "missing tool.web_search span");

  const toolParentName = spanById.get(toolSpanEntry.span.parentSpanId ?? "")?.name;
  assert(
    toolParentName === "agent-b.tool",
    `tool.web_search parent should be 'agent-b.tool', got '${toolParentName}'`,
  );

  // ── code.* attribute round-trip ─────────────────────────────────────────
  // withLLMCall now stamps caller attributes. Verify they survive the OTLP
  // round-trip so the detail panel "Open in editor" button can appear.
  const llmSpanWithCode = chatSpans.find((e) => {
    const attrs = e.span.attributes ?? [];
    return attrs.some((a) => a.key === "code.file.path");
  });
  assert(
    llmSpanWithCode !== undefined,
    "no 'chat claude-opus-4-8' span carries a code.file.path attribute — caller frame not stamped or not exported",
  );
  const codeFile = llmSpanWithCode.span.attributes?.find((a) => a.key === "code.file.path")
    ?.value.stringValue;
  assert(
    codeFile !== undefined && codeFile.includes("agent-a"),
    `code.file.path should point to agent-a, got: ${codeFile}`,
  );

  // ── write traces.json ────────────────────────────────────────────────────

  const rootSpan = collected.find(
    (e) => e.serviceName === "orchestrator" && !e.span.parentSpanId,
  )?.span;

  const trace = {
    traceId: sharedTraceId,
    rootSpan: rootSpan ?? null,
    spans: collected,
    servicesSeen: [...servicesSeen],
    complete: rootSpan !== undefined,
  };

  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify([trace], null, 2), "utf8");

  console.log(`\ndemo-smoke: PASS`);
  console.log(`  traceId  = ${sharedTraceId}`);
  console.log(`  services = ${[...servicesSeen].join(", ")}`);
  console.log(`  spans    = ${collected.length}`);
  console.log(`  store    → ${STORE_PATH}`);
} finally {
  cleanup(demoProc, receiver);
}
