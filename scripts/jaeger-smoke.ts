/**
 * M0 exit-criteria smoke test: emit one span over OTLP/HTTP (protobuf) and
 * verify it is queryable via the Jaeger API. Requires `npm run jaeger:up` locally
 * (CI provides Jaeger as a service container).
 */
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";

const SERVICE_NAME = "agentgraph-smoke";
const SPAN_NAME = "smoke";
const OTLP_ENDPOINT = process.env.AGENTGRAPH_ENDPOINT ?? "http://localhost:4318";
const JAEGER_QUERY_URL = process.env.JAEGER_QUERY_URL ?? "http://localhost:16686";
const POLL_INTERVAL_MS = 1_000;
const POLL_TIMEOUT_MS = 15_000;

interface JaegerSpan {
  operationName: string;
}

interface JaegerTracesResponse {
  data: Array<{ spans: JaegerSpan[] }>;
}

async function emitSmokeSpan(): Promise<void> {
  const exporter = new OTLPTraceExporter({ url: `${OTLP_ENDPOINT}/v1/traces` });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ "service.name": SERVICE_NAME }),
    spanProcessors: [new SimpleSpanProcessor(exporter)]
  });
  const tracer = provider.getTracer("agentgraph-smoke");

  const span = tracer.startSpan(SPAN_NAME);
  span.setAttribute("agentgraph.smoke", true);
  span.end();

  await provider.forceFlush();
  await provider.shutdown();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function querySmokeTraces(): Promise<JaegerTracesResponse | undefined> {
  const url = `${JAEGER_QUERY_URL}/api/traces?service=${SERVICE_NAME}&limit=20`;
  const response = await fetch(url).catch(() => undefined);
  if (!response?.ok) {
    return undefined;
  }
  return (await response.json()) as JaegerTracesResponse;
}

async function pollForSmokeSpan(): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const body = await querySmokeTraces();
    const hasSmokeSpan = body?.data.some((trace) =>
      trace.spans.some((span) => span.operationName === SPAN_NAME)
    );
    if (hasSmokeSpan) {
      return true;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

async function main(): Promise<void> {
  await emitSmokeSpan();
  const isVisible = await pollForSmokeSpan();
  if (!isVisible) {
    console.error(
      `jaeger smoke FAIL: span "${SPAN_NAME}" for service "${SERVICE_NAME}" not found at ` +
        `${JAEGER_QUERY_URL} within ${POLL_TIMEOUT_MS}ms (is Jaeger up? try: npm run jaeger:up)`
    );
    process.exit(1);
  }
  console.log(`jaeger smoke PASS: span "${SPAN_NAME}" visible via Jaeger query API`);
}

await main();
