import type { SpanEntry } from "../receiver/span-store.js";
import type { SourceFile } from "./types.js";

const MAX_INFERRED_NODES = 8;

export function buildPrompt(
  spans: ReadonlyArray<SpanEntry>,
  sourceFiles: ReadonlyArray<SourceFile>,
  participantIds: ReadonlyArray<string>,
): string {
  const spanLines = spans
    .map(({ span, serviceName }) => {
      const parent = span.parentSpanId ?? "root";
      // Sanitize attacker-controlled fields to prevent prompt injection via newlines.
      const safeName = span.name.replace(/[\r\n]/g, " ");
      const safeService = serviceName.replace(/[\r\n]/g, " ");
      return `[${span.startTimeUnixNano}] spanId=${span.spanId} name=${safeName} service=${safeService} parent=${parent}`;
    })
    .join("\n");

  const sourceSection = sourceFiles
    .map((f) => {
      // Escape triple-backticks inside source content so they cannot prematurely close the fence.
      const safeContent = f.content.replace(/`{3}/g, "`` `");
      return `### ${f.serviceName} — ${f.path}\n\`\`\`\n${safeContent}\n\`\`\``;
    })
    .join("\n\n");

  const participantList = participantIds.map((id) => `- ${id}`).join("\n");

  return `You are analyzing an agentic trace to infer decision nodes and message flows.

## Spans
${spanLines || "(none)"}

## Source Files
${sourceSection || "(none)"}

## Participants
${participantList || "(none)"}

## Task
Analyze the spans and source code above to infer up to ${MAX_INFERRED_NODES} decision nodes and message flows that are implied but not directly observed in the spans.

Return ONLY a JSON array (no other text). Each element must match one of these schemas:

Arrow: { "nodeType": "arrow", "fromParticipantId": string, "toParticipantId": string, "style": "solid"|"dashed", "label": string, "timeNs": string, "codePointer": { "file": string, "line": number, "snippet"?: string }, "reasoning": string }

Action: { "nodeType": "action", "participantId": string, "label": string, "timeNs": string, "codePointer": { "file": string, "line": number, "snippet"?: string }, "reasoning": string }

Only infer nodes strongly supported by evidence. Return [] if nothing can be reliably inferred.`;
}
