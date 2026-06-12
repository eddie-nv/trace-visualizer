/**
 * Test A-lite leg runner (M7): registers the OTel provider the way a host
 * environment would (ai-chatbot uses @vercel/otel; here the repo's standard
 * BasicTracerProvider + OTLP wiring), then runs the AI-SDK app's weather
 * turn. Spawned by the Test C harness so the global tracer state lives in
 * its own process.
 *
 * Env: TEST_A_MOCK_ORIGIN (required), TEST_A_SERVICE (required),
 *      AGENTGRAPH_ENDPOINT (optional, default http://localhost:4318),
 *      BARE_MODEL (optional).
 */
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const mockOrigin = process.env["TEST_A_MOCK_ORIGIN"];
const serviceName = process.env["TEST_A_SERVICE"];
if (mockOrigin === undefined || serviceName === undefined) {
  console.error("test-a run-turn: TEST_A_MOCK_ORIGIN and TEST_A_SERVICE are required");
  process.exit(1);
}
const endpoint = process.env["AGENTGRAPH_ENDPOINT"] ?? "http://localhost:4318";
const model = process.env["BARE_MODEL"] ?? "claude-mock-model";

const provider = new BasicTracerProvider({
  resource: defaultResource().merge(resourceFromAttributes({ "service.name": serviceName })),
  spanProcessors: [
    new SimpleSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
  ],
});
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);

// Import AFTER the provider is registered — mirrors ai-chatbot, where
// instrumentation.ts runs before any route code loads the AI SDK.
const { runWeatherTurn } = await import("../../test-apps/ai-sdk-native/turn.ts");
const text = await runWeatherTurn(`${mockOrigin}/v1`, model);

await provider.forceFlush();
await provider.shutdown();
console.log(`test-a turn complete: "${text}"`);
