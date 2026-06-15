# AgentGraph Demo Runbook

End-to-end walkthrough: install the extension in Cursor, run the 3-agent demo app, and watch the swimlane populate with live spans.

---

## Prerequisites

- Node.js ≥ 22.6.0
- Cursor (or VS Code) installed
- `jq` for formatting curl output (optional but helpful)

---

## Step 1 — Build and install the extension

```bash
# From repo root
cd packages/extension
npm run build       # compiles dist/extension.cjs, dist/webview.js, dist/mcp.js
npm run build:vsix  # produces agentgraph-0.0.0.vsix
cd ../..
```

Install into Cursor:

```bash
cursor --install-extension packages/extension/agentgraph-0.0.0.vsix
```

> **VS Code users:** replace `cursor` with `code`.

Reload the window when prompted (`Ctrl/Cmd + Shift + P` → "Developer: Reload Window").

---

## Step 2 — Verify the panel appears

1. Open the repo root in Cursor.
2. In the Explorer sidebar, expand **AgentGraph Traces**.
   - You should see an empty panel with a placeholder message.
3. The extension starts an OTLP receiver on **localhost:4319** by default.
   - Configurable: `agentgraph.receiverPort` in VS Code/Cursor settings.

---

## Step 3 — Start the demo services

```bash
npm run demo
```

Expected output:

```
AgentGraph demo starting  (endpoint: http://localhost:4319)

  [orchestrator]  :3001
  [agent-a]       :3002
  [agent-b]       :3003

Send a trace:
  curl -s -X POST http://localhost:3001/run -H 'content-type: application/json' -d '{"prompt":"hello"}' | jq
```

Three services start in the same terminal with color-coded prefixes.  
Press **Ctrl+C** to stop all three.

---

## Step 4 — Fire a request

```bash
curl -s -X POST http://localhost:3001/run \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello"}' | jq
```

Expected response:

```json
{
  "ok": true,
  "result": {
    "ok": true,
    "response": "I will search for that information.",
    "tool": {
      "ok": true,
      "result": "Found 3 relevant results."
    }
  }
}
```

---

## Step 5 — Watch 3 columns appear in the swimlane

Switch to the **AgentGraph Traces** panel in the Explorer sidebar.  
Within a moment you should see a new trace row. Click it to expand the swimlane.

- **Column 1 — orchestrator**: HTTP server span wrapping the `/run` handler.
- **Column 2 — agent-a**: LLM span (`chat claude-opus-4-8`) with token counts + HTTP client span to agent-b.
- **Column 3 — agent-b**: `tool.web_search` span (~80 ms).

---

## Step 6 — Inspect a span

Click any span arrow or rectangle in the swimlane.  
The detail panel on the right shows:

- Span name and operation
- Start/end timestamps and duration
- `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` (on the LLM span)
- Raw attributes

---

## Step 7 — Open the source location (optional)

Some spans carry `code.file.path` and `code.line.number` attributes.  
Click **Open file** in the detail panel to jump to that line in the editor.

---

## Step 8 — Query via MCP (optional)

With the MCP server enabled (`claude --mcp` or configured in `.mcp.json`):

```
list_recent_traces()
```

Returns a summary of the last N traces. Then:

```
get_conversation("<traceId>")
```

Returns the full span tree for that trace, including token usage and timing.

---

## Smoke test (CI / quick validation)

Verifies the full chain without the extension running:

```bash
npm run demo:smoke
```

The smoke test:
1. Starts its own lightweight OTLP/JSON receiver on port 4320.
2. Launches all 3 demo services pointing at that receiver.
3. Sends one request and waits for spans.
4. Asserts all 3 services participated and share a single traceId.
5. Writes the collected trace to `~/.agentgraph/traces.json`.
6. Exits 0 on success, 1 on failure.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel doesn't appear | Reload window; check extension is listed in Extensions sidebar |
| No traces appear after curl | Confirm the extension receiver is on the right port: check `agentgraph.receiverPort` matches what `npm run demo` logs |
| Port already in use | `lsof -ti :3001 -ti :3002 -ti :3003 | xargs kill` |
| Swimlane shows only 1 column | Confirm all 3 services are running and the OTLP endpoint is correct |
