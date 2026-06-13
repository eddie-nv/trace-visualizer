import type { OtlpSpan } from "../../src/receiver/otlp-types.js";
import type {
  Arrow,
  ActionNode,
  Fragment,
  Participant,
  SpanEvent,
  ViewModel,
} from "./view-model.js";

export interface SpanEntry {
  readonly span: OtlpSpan;
  readonly serviceName: string;
}

function getStr(span: OtlpSpan, key: string): string | undefined {
  return span.attributes?.find((a) => a.key === key)?.value?.stringValue;
}

function getNum(span: OtlpSpan, key: string): number | undefined {
  const attr = span.attributes?.find((a) => a.key === key);
  if (!attr) return undefined;
  const v = attr.value.intValue ?? attr.value.doubleValue;
  return v !== undefined ? Number(v) : undefined;
}

function isLlmSpan(span: OtlpSpan): boolean {
  const model = getStr(span, "gen_ai.request.model");
  const inputTokens = getNum(span, "gen_ai.usage.input_tokens");
  const outputTokens = getNum(span, "gen_ai.usage.output_tokens");
  return model !== undefined && (inputTokens !== undefined || outputTokens !== undefined);
}

function isToolSpan(span: OtlpSpan): boolean {
  return getStr(span, "ai.toolCall.name") !== undefined;
}

function resolveParticipant(span: OtlpSpan, serviceName: string): Participant {
  const toolName = getStr(span, "ai.toolCall.name");
  if (toolName !== undefined) {
    return { id: toolName, label: toolName, type: "tool" };
  }

  if (isLlmSpan(span)) {
    const model = getStr(span, "gen_ai.request.model") ?? "unknown";
    const provider =
      getStr(span, "gen_ai.provider.name") ??
      getStr(span, "gen_ai.system") ??
      getStr(span, "ai.model.provider") ??
      "unknown";
    const id = `${provider}:${model}`;
    const label = model;
    return { id, label, type: "model" };
  }

  const agentId = getStr(span, "agentgraph.agent.id");
  if (agentId !== undefined) {
    return { id: agentId, label: agentId, type: "agent" };
  }

  const fingerprint = getStr(span, "agentgraph.agent.fingerprint");
  if (fingerprint !== undefined) {
    return {
      id: fingerprint,
      label: `${serviceName} (${fingerprint.slice(0, 8)})`,
      type: "cluster",
    };
  }

  return { id: serviceName, label: serviceName, type: "service" };
}

function resolveSourceParticipant(
  span: OtlpSpan,
  spanMap: Map<string, SpanEntry>,
  serviceName: string,
): Participant {
  if (span.parentSpanId !== undefined) {
    const parentEntry = spanMap.get(span.parentSpanId);
    if (parentEntry !== undefined) {
      return resolveParticipant(parentEntry.span, parentEntry.serviceName);
    }
  }
  return resolveParticipant(span, serviceName);
}

function compareNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function spansToViewModel(entries: ReadonlyArray<SpanEntry>): ViewModel {
  if (entries.length === 0) {
    return { participants: [], arrows: [], actionNodes: [], spanEvents: [], fragments: [] };
  }

  const spanMap = new Map<string, SpanEntry>(entries.map((e) => [e.span.spanId, e]));

  const participantMap = new Map<string, Participant>();
  const arrows: Arrow[] = [];
  const actionNodes: ActionNode[] = [];
  const spanEvents: SpanEvent[] = [];

  const participantOrder: string[] = [];

  function ensureParticipant(p: Participant): void {
    if (!participantMap.has(p.id)) {
      participantMap.set(p.id, p);
      participantOrder.push(p.id);
    }
  }

  for (const { span, serviceName } of entries) {
    const targetParticipant = resolveParticipant(span, serviceName);
    const isCrossService = isLlmSpan(span) || isToolSpan(span);

    if (isCrossService && span.parentSpanId !== undefined) {
      const sourceParticipant = resolveSourceParticipant(span, spanMap, serviceName);
      ensureParticipant(sourceParticipant);
      ensureParticipant(targetParticipant);

      const finishReasons = getStr(span, "gen_ai.response.finish_reasons");
      const inputTokens = getNum(span, "gen_ai.usage.input_tokens");
      const outputTokens = getNum(span, "gen_ai.usage.output_tokens");
      const toolName = getStr(span, "ai.toolCall.name");
      const toolArgs = getStr(span, "ai.toolCall.args");
      const toolResult = getStr(span, "ai.toolCall.result");

      let requestLabel: string;
      let returnLabel: string;

      if (toolName !== undefined) {
        const args = toolArgs !== undefined ? `(${toolArgs})` : "";
        requestLabel = `${toolName}${args}`;
        returnLabel = toolResult ?? "done";
      } else {
        const roundNum =
          arrows.filter((a) => a.style === "solid" && a.toParticipantId === targetParticipant.id)
            .length + 1;
        requestLabel = `chat (round ${roundNum})`;
        const reasons = finishReasons ?? "";
        const usage =
          inputTokens !== undefined && outputTokens !== undefined
            ? ` · ${inputTokens} in / ${outputTokens} out`
            : "";
        returnLabel = `finish=${reasons.replace(/["\[\]]/g, "")}${usage}`;
      }

      arrows.push({
        id: `${span.spanId}-req`,
        fromParticipantId: sourceParticipant.id,
        toParticipantId: targetParticipant.id,
        style: "solid",
        label: requestLabel,
        timeNs: span.startTimeUnixNano,
        spanId: span.spanId,
      });

      arrows.push({
        id: `${span.spanId}-ret`,
        fromParticipantId: targetParticipant.id,
        toParticipantId: sourceParticipant.id,
        style: "dashed",
        label: returnLabel,
        timeNs: span.endTimeUnixNano,
        spanId: span.spanId,
      });

      for (const event of span.events ?? []) {
        spanEvents.push({
          id: `${span.spanId}-${event.name}`,
          name: event.name,
          timeNs: event.timeUnixNano,
          participantId: targetParticipant.id,
          spanId: span.spanId,
        });
      }
    } else {
      ensureParticipant(targetParticipant);
      actionNodes.push({
        id: span.spanId,
        participantId: targetParticipant.id,
        label: span.name,
        timeNs: span.startTimeUnixNano,
        spanId: span.spanId,
      });
    }
  }

  arrows.sort((a, b) => compareNs(a.timeNs, b.timeNs));
  spanEvents.sort((a, b) => compareNs(a.timeNs, b.timeNs));

  const fragments = detectFragments(entries);

  const participants = participantOrder
    .map((id) => participantMap.get(id))
    .filter((p): p is Participant => p !== undefined);

  return { participants, arrows, actionNodes, spanEvents, fragments };
}

function detectFragments(entries: ReadonlyArray<SpanEntry>): Fragment[] {
  const byParent = new Map<string, SpanEntry[]>();
  for (const entry of entries) {
    if (entry.span.parentSpanId !== undefined) {
      const siblings = byParent.get(entry.span.parentSpanId) ?? [];
      siblings.push(entry);
      byParent.set(entry.span.parentSpanId, siblings);
    }
  }

  const fragments: Fragment[] = [];
  for (const [parentId, siblings] of byParent) {
    const byName = new Map<string, string[]>();
    for (const { span } of siblings) {
      const group = byName.get(span.name) ?? [];
      group.push(span.spanId);
      byName.set(span.name, group);
    }
    for (const [name, spanIds] of byName) {
      if (spanIds.length >= 2) {
        fragments.push({
          id: `fragment-${parentId}-${name}`,
          label: `loop [${name} ×${spanIds.length}]`,
          memberSpanIds: spanIds,
        });
      }
    }
  }
  return fragments;
}
