import Anthropic from "@anthropic-ai/sdk";
import type { OutputChannel } from "vscode";
import type { LlmInferredNode } from "./types.js";

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 2048;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1_500;

export async function callLlm(
  apiKey: string,
  prompt: string,
  outputChannel: OutputChannel,
): Promise<LlmInferredNode[] | null> {
  const client = new Anthropic({ apiKey, maxRetries: 0 });

  const text = await callWithRetry(client, prompt, outputChannel);
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    outputChannel.appendLine("[AgentGraph] LLM enrichment: failed to parse JSON response");
    return null;
  }

  if (!Array.isArray(parsed)) {
    outputChannel.appendLine("[AgentGraph] LLM enrichment: response is not an array");
    return null;
  }

  const valid = (parsed as unknown[]).filter(isValidLlmInferredNode);
  const dropped = parsed.length - valid.length;
  if (dropped > 0) {
    outputChannel.appendLine(`[AgentGraph] LLM enrichment: dropped ${dropped} invalid nodes`);
  }

  return valid;
}

async function callWithRetry(
  client: Anthropic,
  prompt: string,
  outputChannel: OutputChannel,
): Promise<string | null> {
  let attempt = 0;
  while (true) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      });
      return extractText(response);
    } catch (error) {
      if (attempt < MAX_RETRIES) {
        attempt++;
        await delay(RETRY_DELAY_MS);
        continue;
      }
      outputChannel.appendLine(
        `[AgentGraph] LLM enrichment failed after ${MAX_RETRIES + 1} attempts: ${errorMessage(error)}`,
      );
      return null;
    }
  }
}

function extractText(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function extractJson(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return match ? match[1]!.trim() : text.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isValidLlmInferredNode(node: unknown): node is LlmInferredNode {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;

  if (!isValidCodePointer(n["codePointer"])) return false;
  if (typeof n["label"] !== "string") return false;
  if (typeof n["timeNs"] !== "string") return false;
  if (typeof n["reasoning"] !== "string") return false;

  if (n["nodeType"] === "arrow") {
    return (
      typeof n["fromParticipantId"] === "string" &&
      typeof n["toParticipantId"] === "string" &&
      (n["style"] === "solid" || n["style"] === "dashed")
    );
  }
  if (n["nodeType"] === "action") {
    return typeof n["participantId"] === "string";
  }
  return false;
}

function isValidCodePointer(cp: unknown): boolean {
  if (!cp || typeof cp !== "object") return false;
  const p = cp as Record<string, unknown>;
  return (
    typeof p["file"] === "string" &&
    isRelativeSafePath(p["file"]) &&
    typeof p["line"] === "number"
  );
}

function isRelativeSafePath(file: string): boolean {
  return (
    file.length > 0 &&
    !file.startsWith("/") &&
    !file.startsWith("~") &&
    !file.split("/").includes("..")
  );
}
