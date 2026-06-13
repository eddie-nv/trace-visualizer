import * as http from "node:http";
import { context, propagation, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { withLLMCall } from "@agentgraph/core";
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const PORT = 3002;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/process") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // Extract W3C traceparent from incoming headers to continue the trace from orchestrator.
  const inCarrier: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") inCarrier[k] = v;
  }
  const parentContext = propagation.extract(ROOT_CONTEXT, inCarrier);

  await context.with(parentContext, async () => {
    try {
      const body = JSON.parse(await readBody(req)) as { prompt?: string };
      const prompt = body.prompt ?? "hello";

      const llmResponse = await withLLMCall(
        { provider: "anthropic", operation: "chat" },
        async (span) => {
          const after = span.reportRequest({
            model: "claude-opus-4-8",
            messages: [{ role: "user", content: prompt }],
          });

          await new Promise<void>((r) => setTimeout(r, 150));

          const reply = "I will search for that information.";
          after.reportResponse({
            model: "claude-opus-4-8",
            usage: { inputTokens: 45, outputTokens: 28 },
            finishReasons: ["end_turn"],
            messages: [{ role: "assistant", content: reply }],
          });
          return reply;
        },
      );

      // Inject traceparent so agent-b joins the same trace.
      const outCarrier: Record<string, string> = {};
      propagation.inject(context.active(), outCarrier);

      const toolResponse = await fetch("http://localhost:3003/tool", {
        method: "POST",
        headers: { "content-type": "application/json", ...outCarrier },
        body: JSON.stringify({ task: llmResponse }),
      });
      const toolResult = (await toolResponse.json()) as unknown;

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, response: llmResponse, tool: toolResult }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: String(err) }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
