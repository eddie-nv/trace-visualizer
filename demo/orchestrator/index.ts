import * as http from "node:http";

const PORT = 3001;

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

  try {
    const body = JSON.parse(await readBody(req)) as { prompt?: string };
    const prompt = body.prompt ?? "hello";

    const agentResponse = await fetch("http://localhost:3002/process", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const result = (await agentResponse.json()) as unknown;

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result }));
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: String(err) }));
  }
});

server.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
