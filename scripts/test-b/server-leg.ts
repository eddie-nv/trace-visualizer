/**
 * Spawns one bare-app "leg" of Test B (DESIGN §6) — a runtime × entry ×
 * preload combination — captures both endpoints' full responses, and (for
 * traced legs) waits for the leg's spans to land in Jaeger before the
 * subprocess is killed (SimpleSpanProcessor exports on span end, so the
 * process must outlive the export).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { capturePost, type CapturedResponse } from "./capture.ts";
import { waitForSpans, type JaegerSpan } from "./jaeger.ts";

export const MODEL = "claude-mock-model";
export const PROMPT_BODY = { prompt: "Say hello." } as const;
/** Spans expected per traced leg: one /chat + one /chat-stream. */
export const SPANS_PER_LEG = 2;

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BARE_APP_DIR = "test-apps/bare";
const HEALTH_POLL_INTERVAL_MS = 200;
const HEALTH_TIMEOUT_MS = 15_000;
const EXIT_TIMEOUT_MS = 5_000;

export interface LegConfig {
  readonly label: string;
  readonly runtime: "node" | "bun";
  /** Entry file inside test-apps/bare; defaults to the zero-touch server. */
  readonly entry?: "server.ts" | "server-one-line.ts" | "server-tier2.ts";
  /** Load @agentgraph/register (NODE_OPTIONS --import / bun --preload). */
  readonly preload?: boolean;
  readonly port: number;
  readonly mockOrigin: string;
  /**
   * When set, the leg runs with tracing env (endpoint, test match origin,
   * simple processor) and this Jaeger service name; baseline legs omit it.
   */
  readonly serviceName?: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface LegResult {
  readonly label: string;
  readonly chat: CapturedResponse;
  readonly stream: CapturedResponse;
  /** Empty for untraced (baseline) legs. */
  readonly spans: readonly JaegerSpan[];
  readonly stderr: string;
}

export async function runLeg(config: LegConfig): Promise<LegResult> {
  const child = spawnLeg(config);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });

  try {
    const origin = `http://127.0.0.1:${config.port}`;
    await waitForHealthy(child, origin, () => stderr);
    const chat = await capturePost(origin, "/chat", PROMPT_BODY);
    const stream = await capturePost(origin, "/chat-stream", PROMPT_BODY);
    // Two identically-failing legs would still be byte-identical — require
    // success here so criterion 4 can never pass on matching error responses.
    for (const [endpoint, captured] of [
      ["/chat", chat],
      ["/chat-stream", stream],
    ] as const) {
      if (captured.status !== 200) {
        throw new Error(
          `${endpoint} returned ${captured.status}: ${new TextDecoder().decode(captured.body)}`,
        );
      }
    }
    const spans =
      config.serviceName === undefined ? [] : await waitForSpans(config.serviceName, SPANS_PER_LEG);
    return { label: config.label, chat, stream, spans, stderr };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`leg "${config.label}" failed: ${detail}\n--- leg stderr ---\n${stderr}`);
  } finally {
    await terminate(child, exited);
  }
}

function spawnLeg(config: LegConfig): ChildProcess {
  const entry = `${BARE_APP_DIR}/${config.entry ?? "server.ts"}`;
  const isBun = config.runtime === "bun";
  const command = isBun ? "bun" : process.execPath;
  const args =
    isBun && config.preload === true ? ["--preload", "@agentgraph/register", entry] : [entry];
  return spawn(command, args, {
    cwd: REPO_ROOT,
    env: legEnv(config),
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function legEnv(config: LegConfig): Record<string, string> {
  // Strip inherited AGENTGRAPH_* and NODE_OPTIONS so the developer's shell
  // cannot leak tracing config into baseline legs.
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !key.startsWith("AGENTGRAPH_") && key !== "NODE_OPTIONS",
    ),
  ) as Record<string, string>;
  return {
    ...clean,
    PORT: String(config.port),
    BARE_MODEL: MODEL,
    ANTHROPIC_API_KEY: "mock-key",
    ANTHROPIC_BASE_URL: config.mockOrigin,
    ...(config.serviceName !== undefined && {
      AGENTGRAPH_ENDPOINT: process.env["AGENTGRAPH_ENDPOINT"] ?? "http://localhost:4318",
      AGENTGRAPH_TEST_MATCH_ORIGIN: `anthropic=${config.mockOrigin}`,
      AGENTGRAPH_DISABLE_BATCH: "true",
      npm_package_name: config.serviceName,
    }),
    ...(config.runtime === "node" &&
      config.preload === true && { NODE_OPTIONS: "--import @agentgraph/register" }),
    ...config.extraEnv,
  };
}

async function waitForHealthy(
  child: ChildProcess,
  origin: string,
  stderrSoFar: () => string,
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited(child)) {
      throw new Error(
        `server exited (code ${child.exitCode}, signal ${child.signalCode}) before becoming healthy`,
      );
    }
    const response = await fetch(`${origin}/healthz`).catch(() => undefined);
    if (response?.ok === true) {
      await response.text();
      return;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }
  throw new Error(`server not healthy within ${HEALTH_TIMEOUT_MS}ms\n${stderrSoFar()}`);
}

/** exitCode is null for signal-killed children — signalCode is set instead. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminate(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (hasExited(child)) {
    return;
  }
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    sleep(EXIT_TIMEOUT_MS).then(() => true),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
