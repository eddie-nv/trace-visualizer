/**
 * Subprocess exit-criteria checks for `@agentgraph/register` (M4). Run after
 * `npm run build`.
 *
 * Under Node: ESM entry via `--import`, CJS twin via `--require`, double
 * registration (both twins in one process) is a no-op, and a broken env warns
 * once without crashing the host.
 *
 * Under Bun: `bun --preload @agentgraph/register` loads the entry and the
 * host still runs (DESIGN §1 Bun leg).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOST_MARKER = "host-alive";
const WARN_MARKER = "agentgraph:";
const HOST_FIXTURE = fileURLToPath(new URL("./fixtures/preload-host.mjs", import.meta.url));

interface SmokeResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHost(
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): SmokeResult {
  const { status, stdout, stderr, error } = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (error !== undefined) {
    throw new Error(`failed to spawn ${command}: ${error.message}`);
  }
  return { status, stdout, stderr };
}

// Line-anchored: a single warning may quote a nested error that itself starts
// with the marker, so substring counting would double-count one warn event.
function countWarnLines(stderr: string): number {
  return stderr.split("\n").filter((line) => line.startsWith(WARN_MARKER)).length;
}

function assertHostSurvived(result: SmokeResult, label: string): void {
  assert.equal(
    result.status,
    0,
    `${label}: host exited ${result.status}\nstderr: ${result.stderr}`,
  );
  assert.match(result.stdout, new RegExp(HOST_MARKER), `${label}: host script never ran`);
}

const isBun = process.versions.bun !== undefined;

if (isBun) {
  const preload = runHost("bun", ["--preload", "@agentgraph/register", HOST_FIXTURE]);
  assertHostSurvived(preload, "bun --preload");
  assert.equal(
    countWarnLines(preload.stderr),
    0,
    `bun --preload: unexpected warning\nstderr: ${preload.stderr}`,
  );
  console.log("register smoke PASS (Bun): --preload loads the entry and the host survives");
} else {
  const node = process.execPath;

  const esm = runHost(node, ["--import", "@agentgraph/register", HOST_FIXTURE]);
  assertHostSurvived(esm, "node --import");
  assert.equal(
    countWarnLines(esm.stderr),
    0,
    `node --import: unexpected warning\nstderr: ${esm.stderr}`,
  );

  const cjs = runHost(node, ["--require", "@agentgraph/register/cjs", HOST_FIXTURE]);
  assertHostSurvived(cjs, "node --require");
  assert.equal(
    countWarnLines(cjs.stderr),
    0,
    `node --require: unexpected warning\nstderr: ${cjs.stderr}`,
  );

  // Both twins in one process: the global flag must dedupe — neither the
  // sdk's "init() called more than once" warning nor any other may appear.
  const both = runHost(node, [
    "--require",
    "@agentgraph/register/cjs",
    "--import",
    "@agentgraph/register",
    HOST_FIXTURE,
  ]);
  assertHostSurvived(both, "double registration");
  assert.equal(
    countWarnLines(both.stderr),
    0,
    `double registration: expected silence, got\nstderr: ${both.stderr}`,
  );

  // Broken env: init() fails fast on the bad endpoint; the preload must
  // downgrade that to exactly one warning and still run the host script.
  const broken = runHost(node, ["--import", "@agentgraph/register", HOST_FIXTURE], {
    AGENTGRAPH_ENDPOINT: "not a url",
  });
  assertHostSurvived(broken, "broken env");
  assert.equal(
    countWarnLines(broken.stderr),
    1,
    `broken env: expected exactly one warning\nstderr: ${broken.stderr}`,
  );

  console.log(
    "register smoke PASS (Node): --import, --require, double registration, and broken env all keep the host alive",
  );
}
