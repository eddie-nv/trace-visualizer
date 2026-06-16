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

function resolveParticipant(span: OtlpSpan, serviceName: string): Participant {
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
    const parentEntry =
      span.parentSpanId !== undefined ? spanMap.get(span.parentSpanId) : undefined;

    if (parentEntry !== undefined && parentEntry.serviceName !== serviceName) {
      const sourceParticipant = resolveParticipant(parentEntry.span, parentEntry.serviceName);
      // Skip cross-service arrows when both sides resolve to the same participant
      // (e.g. same agentgraph.agent.id spanning two service names).
      if (sourceParticipant.id === targetParticipant.id) {
        ensureParticipant(targetParticipant);
        actionNodes.push({
          kind: "observed",
          id: span.spanId,
          participantId: targetParticipant.id,
          label: span.name,
          timeNs: span.startTimeUnixNano,
          spanId: span.spanId,
        });
        continue;
      }
      ensureParticipant(sourceParticipant);
      ensureParticipant(targetParticipant);

      arrows.push({
        kind: "observed",
        id: `${span.spanId}-req`,
        fromParticipantId: sourceParticipant.id,
        toParticipantId: targetParticipant.id,
        style: "solid",
        label: span.name,
        timeNs: span.startTimeUnixNano,
        spanId: span.spanId,
      });

      // endTimeUnixNano is safe here — spansToViewModel expects completed spans only.
      arrows.push({
        kind: "observed",
        id: `${span.spanId}-ret`,
        fromParticipantId: targetParticipant.id,
        toParticipantId: sourceParticipant.id,
        style: "dashed",
        label: span.name,
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

      actionNodes.push({
        kind: "observed",
        id: span.spanId,
        participantId: targetParticipant.id,
        label: span.name,
        timeNs: span.startTimeUnixNano,
        spanId: span.spanId,
      });
    } else {
      ensureParticipant(targetParticipant);
      actionNodes.push({
        kind: "observed",
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
