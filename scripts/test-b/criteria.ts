/**
 * The five Test B pass criteria plus the one-line tier check (DESIGN §6),
 * asserted against Jaeger query results and captured HTTP responses. Each
 * assertion returns evidence lines for the verification report; failures
 * throw with the offending leg and attribute named.
 */
import assert from "node:assert/strict";
import { diffCaptures } from "./capture.ts";
import { tagValue, type JaegerSpan } from "./jaeger.ts";
import {
  MOCK_JSON_MESSAGE_ID,
  MOCK_STOP_REASON,
  MOCK_STREAM_MESSAGE_ID,
  MOCK_USAGE,
} from "./mock-anthropic.ts";
import { MODEL, SPANS_PER_LEG, type LegResult } from "./server-leg.ts";

const ATTR = {
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  AGENT_ID: "agentgraph.agent.id",
} as const;

const CONTENT_ATTRIBUTES = [
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "gen_ai.output.messages",
] as const;

export interface Evidence {
  readonly criterion: string;
  readonly detail: string;
}

interface LegSpans {
  readonly json: JaegerSpan;
  readonly stream: JaegerSpan;
}

function spansOf(leg: LegResult): LegSpans {
  assert.equal(
    leg.spans.length,
    SPANS_PER_LEG,
    `${leg.label}: expected exactly ${SPANS_PER_LEG} spans, got ${leg.spans.length}`,
  );
  const json = leg.spans.find((span) => tagValue(span, ATTR.RESPONSE_ID) === MOCK_JSON_MESSAGE_ID);
  const stream = leg.spans.find(
    (span) => tagValue(span, ATTR.RESPONSE_ID) === MOCK_STREAM_MESSAGE_ID,
  );
  assert.ok(json, `${leg.label}: no span with ${ATTR.RESPONSE_ID}=${MOCK_JSON_MESSAGE_ID}`);
  assert.ok(stream, `${leg.label}: no span with ${ATTR.RESPONSE_ID}=${MOCK_STREAM_MESSAGE_ID}`);
  return { json, stream };
}

/** Criterion 1 (and the attribute half of criterion 5): both endpoints emit
 * `chat {model}` spans with provider, model, usage, and content attrs. */
export function assertSpanAttributes(leg: LegResult): Evidence {
  const { json, stream } = spansOf(leg);
  for (const [kind, span] of [
    ["non-streaming", json],
    ["streaming", stream],
  ] as const) {
    const where = `${leg.label}/${kind}`;
    assert.equal(span.operationName, `chat ${MODEL}`, `${where}: span name`);
    assert.equal(tagValue(span, ATTR.PROVIDER_NAME), "anthropic", `${where}: provider`);
    assert.equal(tagValue(span, ATTR.REQUEST_MODEL), MODEL, `${where}: request model`);
    assert.equal(
      Number(tagValue(span, ATTR.USAGE_INPUT_TOKENS)),
      MOCK_USAGE.input_tokens,
      `${where}: input tokens`,
    );
    assert.equal(
      Number(tagValue(span, ATTR.USAGE_OUTPUT_TOKENS)),
      MOCK_USAGE.output_tokens,
      `${where}: output tokens`,
    );
    assert.ok(
      String(tagValue(span, ATTR.RESPONSE_FINISH_REASONS) ?? "").includes(MOCK_STOP_REASON),
      `${where}: finish_reasons missing "${MOCK_STOP_REASON}"`,
    );
    for (const contentAttr of [CONTENT_ATTRIBUTES[0], CONTENT_ATTRIBUTES[3]]) {
      assert.notEqual(
        tagValue(span, contentAttr),
        undefined,
        `${where}: content attr ${contentAttr} missing (content is on)`,
      );
    }
  }
  return {
    criterion: "1: span attributes",
    detail: `${leg.label}: both spans "chat ${MODEL}" with provider/model/usage/messages`,
  };
}

/** Criterion 2: streaming usage (accumulated from message_start/message_delta)
 * equals the non-streaming usage for the identical prompt. */
export function assertUsageParity(leg: LegResult): Evidence {
  const { json, stream } = spansOf(leg);
  for (const attr of [ATTR.USAGE_INPUT_TOKENS, ATTR.USAGE_OUTPUT_TOKENS]) {
    assert.equal(
      Number(tagValue(stream, attr)),
      Number(tagValue(json, attr)),
      `${leg.label}: ${attr} differs between streaming and non-streaming`,
    );
  }
  return {
    criterion: "2: streaming usage parity",
    detail: `${leg.label}: streaming == non-streaming (${MOCK_USAGE.input_tokens} in / ${MOCK_USAGE.output_tokens} out)`,
  };
}

/** Criterion 3: AGENTGRAPH_TRACE_CONTENT=false removes exactly the four
 * content attributes while usage/model/finish_reasons survive. */
export function assertContentRemoved(leg: LegResult): Evidence {
  const { json, stream } = spansOf(leg);
  for (const span of [json, stream]) {
    for (const contentAttr of CONTENT_ATTRIBUTES) {
      assert.equal(
        tagValue(span, contentAttr),
        undefined,
        `${leg.label}: ${contentAttr} present despite AGENTGRAPH_TRACE_CONTENT=false`,
      );
    }
    assert.equal(tagValue(span, ATTR.REQUEST_MODEL), MODEL, `${leg.label}: model survived`);
    assert.equal(
      Number(tagValue(span, ATTR.USAGE_OUTPUT_TOKENS)),
      MOCK_USAGE.output_tokens,
      `${leg.label}: usage survived`,
    );
    assert.ok(
      String(tagValue(span, ATTR.RESPONSE_FINISH_REASONS) ?? "").includes(MOCK_STOP_REASON),
      `${leg.label}: finish_reasons survived`,
    );
  }
  return {
    criterion: "3: content toggle",
    detail: `${leg.label}: 4 content attrs absent; usage/model/finish_reasons intact`,
  };
}

/** Criterion 4 (F6/teeing regression gate): both endpoints' responses are
 * byte-identical with and without the preload. */
export function assertByteIdentity(baseline: LegResult, traced: LegResult): Evidence {
  for (const [endpoint, a, b] of [
    ["/chat", baseline.chat, traced.chat],
    ["/chat-stream", baseline.stream, traced.stream],
  ] as const) {
    const diff = diffCaptures(a, b);
    assert.equal(
      diff,
      undefined,
      `${baseline.label} vs ${traced.label} ${endpoint}: ${diff ?? ""}`,
    );
  }
  return {
    criterion: "4: byte-identical responses",
    detail: `${baseline.label} vs ${traced.label}: status+headers+body identical on /chat (${baseline.chat.body.length}B) and /chat-stream (${baseline.stream.body.length}B SSE)`,
  };
}

/** One-line tier: init({agentId}) stamps agentgraph.agent.id on every span. */
export function assertAgentId(leg: LegResult, expectedAgentId: string): Evidence {
  assert.equal(leg.spans.length, SPANS_PER_LEG, `${leg.label}: span count`);
  for (const span of leg.spans) {
    assert.equal(
      tagValue(span, ATTR.AGENT_ID),
      expectedAgentId,
      `${leg.label}: span "${span.operationName}" missing ${ATTR.AGENT_ID}="${expectedAgentId}"`,
    );
  }
  return {
    criterion: "one-line tier: agent id stamping",
    detail: `${leg.label}: all ${leg.spans.length} spans carry ${ATTR.AGENT_ID}="${expectedAgentId}"`,
  };
}
