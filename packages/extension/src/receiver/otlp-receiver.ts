import * as http from "node:http";
import { getStringAttr, type OtlpEnvelope, type OtlpSpan } from "./otlp-types.js";
import type { SpanStore } from "./span-store.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;

export interface OtlpProcessResult {
  readonly status: number;
  readonly body: string;
}

export type SpanCallback = (traceId: string, span: OtlpSpan, serviceName: string) => void;

export function processOtlpBody(
  rawBody: string,
  contentType: string | undefined,
  store: SpanStore,
  onSpan: SpanCallback,
): OtlpProcessResult {
  const ct = contentType?.split(";")[0]?.trim() ?? "";
  if (!ct.startsWith("application/json")) {
    return { status: 415, body: "Unsupported Media Type: expected application/json" };
  }
  if (rawBody.length > MAX_BODY_BYTES) {
    return { status: 400, body: "Request body too large" };
  }

  let envelope: OtlpEnvelope;
  try {
    envelope = JSON.parse(rawBody) as OtlpEnvelope;
  } catch {
    return { status: 400, body: "Invalid JSON" };
  }

  for (const resourceSpan of envelope.resourceSpans ?? []) {
    const serviceName =
      getStringAttr(resourceSpan.resource?.attributes, "service.name") ?? "unknown";
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        store.addSpan(resourceSpan, span);
        onSpan(span.traceId, span, serviceName);
      }
    }
  }

  return { status: 200, body: "{}" };
}

export interface ReceiverOptions {
  readonly port: number;
  readonly jaegerEndpoint?: string;
  readonly onSpan: SpanCallback;
  readonly onError?: (err: Error) => void;
}

export function createOtlpReceiver(store: SpanStore, opts: ReceiverOptions): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let sizeExceeded = false;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sizeExceeded = true;
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (sizeExceeded) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end("Request body too large");
        return;
      }

      const body = Buffer.concat(chunks);
      const rawBody = body.toString("utf-8");
      const result = processOtlpBody(rawBody, req.headers["content-type"], store, opts.onSpan);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(result.body);

      if (result.status === 200 && opts.jaegerEndpoint) {
        forwardToJaeger(opts.jaegerEndpoint, body).catch(() => {
          // Best-effort forwarding — never fail the primary path.
        });
      }
    });

    req.on("error", (err) => {
      opts.onError?.(err);
      res.writeHead(500);
      res.end("Internal Server Error");
    });
  });

  server.listen(opts.port, "127.0.0.1");
  return server;
}

async function forwardToJaeger(jaegerEndpoint: string, body: Buffer): Promise<void> {
  const url = `${jaegerEndpoint}/v1/traces`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body.toString("utf8"),
  });
}
