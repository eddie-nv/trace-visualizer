import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENDPOINT = process.env.AGENTGRAPH_ENDPOINT ?? "http://localhost:4319";

const RESET = "\x1b[0m";
const services = [
  { name: "orchestrator", file: "orchestrator/index.ts", port: 3001, color: "\x1b[36m" },
  { name: "agent-a", file: "agent-a/index.ts", port: 3002, color: "\x1b[32m" },
  { name: "agent-b", file: "agent-b/index.ts", port: 3003, color: "\x1b[33m" },
] as const;

console.log(`AgentGraph demo starting  (endpoint: ${ENDPOINT})\n`);
for (const svc of services) {
  console.log(`  ${svc.color}[${svc.name}]${RESET}  :${svc.port}`);
}
console.log(`\nSend a trace:\n  curl -s -X POST http://localhost:3001/run -H 'content-type: application/json' -d '{"prompt":"hello"}' | jq\n`);

const children: ChildProcess[] = services.map(({ name, file, color }) => {
  const child = spawn("node", ["--import", "@agentgraph/register", resolve(__dirname, file)], {
    env: {
      ...process.env,
      npm_package_name: name,
      AGENTGRAPH_ENDPOINT: ENDPOINT,
      AGENTGRAPH_DISABLE_BATCH: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const prefix = `${color}[${name}]${RESET} `;
  child.stdout?.on("data", (d: Buffer) => process.stdout.write(prefix + d.toString()));
  child.stderr?.on("data", (d: Buffer) => process.stderr.write(prefix + d.toString()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`${prefix}exited with code ${code}`);
    }
  });

  return child;
});

process.on("SIGINT", () => {
  console.log("\nStopping demo...");
  for (const c of children) c.kill();
  process.exit(0);
});
