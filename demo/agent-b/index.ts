import * as http from "node:http";
import { context, propagation, trace, SpanKind, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const PORT = 3003;
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
  if (req.method !== "POST" || req.url !== "/tool") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Extract W3C traceparent from incoming headers to continue the trace from agent-a.
  const carrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") carrier[k] = v;
  }
  const parentContext = propagation.extract(ROOT_CONTEXT, carrier);

  await context.with(parentContext, async () => {
    try {
      const body = JSON.parse(await readBody(req)) as { task?: string };

      const result = await tracer.startActiveSpan(
        "tool.web_search",
        {
          kind: SpanKind.INTERNAL,
          // ai.toolCall.* keys are required for span-classifier.ts#isToolSpan()
          // to draw request/response arrows instead of an orphaned action node.
          attributes: { "ai.toolCall.name": "web_search", "ai.toolCall.args": body.task ?? "" },
        },
        async (span) => {
          await new Promise<void>((r) => setTimeout(r, 80));
          const output = "Found 3 relevant results.";
          span.setAttribute("ai.toolCall.result", output);
          span.end();
          return output;
        },
      );

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
