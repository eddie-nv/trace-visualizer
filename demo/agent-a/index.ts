import * as http from "node:http";
import { context, propagation, trace, SpanKind, ROOT_CONTEXT } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { withLLMCall } from "@agentgraph/core";
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const PORT = 3002;
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
    await tracer.startActiveSpan("agent-a.process", { kind: SpanKind.SERVER }, async (agentASpan) => {
      try {
        const body = JSON.parse(await readBody(req)) as { prompt?: string };
        const prompt = body.prompt ?? "hello";

        // Capture the LLM span context inside the withLLMCall callback so that
        // agent-b.tool (and its web_search child) become descendants of chat turn 1.
        let llmSpanContext = context.active();

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
            llmSpanContext = context.active(); // LLM span still active here
            return reply;
          },
        );

        const outCarrier: Record<string, string> = {};
        propagation.inject(llmSpanContext, outCarrier);

        const toolResponse = await fetch("http://localhost:3003/tool", {
          method: "POST",
          headers: { "content-type": "application/json", ...outCarrier },
          body: JSON.stringify({ task: llmResponse }),
        });
        if (!toolResponse.ok) {
          throw new Error(`agent-b returned HTTP ${toolResponse.status}`);
        }
        const toolResult = (await toolResponse.json()) as { ok: boolean; result?: string };

        // LLM turn 2: context.active() has reverted to agent-a.process so this
        // span is a sibling of turn 1 (both children of agent-a.process).
        const finalAnswer = await withLLMCall(
          { provider: "anthropic", operation: "chat" },
          async (span) => {
            const after = span.reportRequest({
              model: "claude-opus-4-8",
              messages: [
                { role: "user", content: prompt },
                { role: "assistant", content: llmResponse },
                { role: "user", content: `Tool result: ${toolResult.result ?? ""}` },
              ],
            });

            await new Promise<void>((r) => setTimeout(r, 120));

            const reply = `Based on the search results: ${toolResult.result ?? "no results"}`;
            after.reportResponse({
              model: "claude-opus-4-8",
              usage: { inputTokens: 68, outputTokens: 32 },
              finishReasons: ["end_turn"],
              messages: [{ role: "assistant", content: reply }],
            });
            return reply;
          },
        );

        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, response: finalAnswer, tool: toolResult }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      } finally {
        agentASpan.end();
      }
    });
  });
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
