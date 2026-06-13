import * as http from "node:http";
import { context, propagation, trace, SpanKind } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const PORT = 3001;
const tracer = trace.getTracer("agentgraph-demo");

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/run") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  await tracer.startActiveSpan("orchestrator.run", { kind: SpanKind.SERVER }, async (span) => {
    try {
      const body = JSON.parse(await readBody(req)) as { prompt?: string };
      const prompt = body.prompt ?? "hello";

      // Inject W3C traceparent into outgoing fetch so agent-a continues the trace.
      const carrier: Record<string, string> = {};
      propagation.inject(context.active(), carrier);

      const agentResponse = await fetch("http://localhost:3002/process", {
        method: "POST",
        headers: { "content-type": "application/json", ...carrier },
        body: JSON.stringify({ prompt }),
      });
      const result = (await agentResponse.json()) as unknown;

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    } finally {
      span.end();
    }
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
