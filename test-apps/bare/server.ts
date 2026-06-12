/**
 * Test B bare app (DESIGN §6): a plain Node/TS HTTP server using
 * `@anthropic-ai/sdk` directly. Deliberately contains ZERO OTel or
 * agentgraph imports — tier-0 tracing must come entirely from the preload.
 * Runnable under both Node (type stripping) and Bun.
 *
 * Endpoints:
 *   GET  /healthz      → readiness probe
 *   POST /chat         → messages.create (non-streaming), echoes the message JSON
 *   POST /chat-stream  → messages.create stream:true, re-emits every event as SSE
 *
 * Env: PORT, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (optional), BARE_MODEL.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";

const PORT = Number(process.env["PORT"] ?? 8787);
const MODEL = process.env["BARE_MODEL"] ?? "claude-sonnet-4-5";
const MAX_TOKENS = 256;
const MAX_BODY_BYTES = 1024 * 1024;

const baseURL = process.env["ANTHROPIC_BASE_URL"];
const client = new Anthropic({
  // Explicit so the test harness does not depend on the SDK's own env reading.
  ...(baseURL !== undefined && { baseURL }),
});

// No parameter properties — Node's strip-only TS mode cannot erase them.
class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const server = createServer((req, res) => {
  void route(req, res);
});

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && req.url === "/chat") {
      await handleChat(req, res);
      return;
    }
    if (req.method === "POST" && req.url === "/chat-stream") {
      await handleChatStream(req, res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    respondWithError(res, error);
  }
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const prompt = await readPrompt(req);
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  sendJson(res, 200, message);
}

async function handleChatStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const prompt = await readPrompt(req);
  const stream = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    stream: true,
    messages: [{ role: "user", content: prompt }],
  });
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  for await (const event of stream) {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  res.end();
}

/** Boundary validation: the request body must be `{"prompt": "<non-empty>"}`. */
async function readPrompt(req: IncomingMessage): Promise<string> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  const prompt = (parsed as Record<string, unknown>)["prompt"];
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new HttpError(400, 'request body must include a non-empty string "prompt"');
  }
  return prompt;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

function respondWithError(res: ServerResponse, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`bare-test-app: request failed: ${detail}`);
  if (res.headersSent) {
    // Mid-stream failure: the only honest signal left is killing the socket.
    res.destroy();
    return;
  }
  const status = error instanceof HttpError ? error.status : 500;
  sendJson(res, status, { error: detail });
}

server.listen(PORT, "127.0.0.1", () => {
  console.error(`bare-test-app listening on http://127.0.0.1:${PORT}`);
});
