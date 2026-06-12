/**
 * Test A pass criteria (DESIGN §6 Test A, adapted to the A-lite leg): the
 * native AI SDK trace for one weather turn must contain the documented tree —
 * `ai.streamText` root, two `doStream` steps with GenAI attrs, one
 * `ai.toolCall` under step 1 — with sane parenting and timestamps
 * (FINDINGS §8).
 */
import assert from "node:assert/strict";
import { parentSpanId, tagRecord, type JaegerSpan } from "../test-b/jaeger.ts";
import { MOCK_TOOL_NAME } from "../test-b/mock-anthropic.ts";

export const TEST_A_EXPECTED_SPANS = 4;

export interface TestATree {
  readonly traceId: string;
  readonly root: JaegerSpan;
  /** Ordered by start time: [tool-call step, continuation step]. */
  readonly doStreams: readonly [JaegerSpan, JaegerSpan];
  readonly toolCall: JaegerSpan;
}

export function assertTestATree(spans: readonly JaegerSpan[]): TestATree {
  const byOperation = (operationId: string): JaegerSpan[] =>
    spans.filter((span) => tagRecord(span)["ai.operationId"] === operationId);

  const roots = byOperation("ai.streamText");
  assert.equal(roots.length, 1, `expected 1 ai.streamText root, got ${roots.length}`);
  const root = roots[0]!;

  const doStreams = [...byOperation("ai.streamText.doStream")].sort(
    (a, b) => a.startTime - b.startTime,
  );
  assert.equal(doStreams.length, 2, `expected 2 doStream steps, got ${doStreams.length}`);
  // Safe: the assert above guarantees both elements; node:assert carries no
  // type-narrowing signature TS could use here.
  const [stepOne, stepTwo] = doStreams as [JaegerSpan, JaegerSpan];

  const toolCalls = byOperation("ai.toolCall");
  assert.equal(toolCalls.length, 1, `expected 1 ai.toolCall span, got ${toolCalls.length}`);
  const toolCall = toolCalls[0]!;
  assert.equal(
    tagRecord(toolCall)["ai.toolCall.name"],
    MOCK_TOOL_NAME,
    "toolCall is the weather tool",
  );

  for (const span of [stepOne, stepTwo, toolCall]) {
    assert.equal(span.traceID, root.traceID, `${span.operationName}: span left the turn's trace`);
  }

  // Parenting, verified empirically against ai@6.0.203: both steps AND the
  // toolCall parent under the root. FINDINGS §8 sketched the toolCall under
  // step-1's doStream, but that citation is v7 (`@ai-sdk/otel`) behavior —
  // v6 starts tool spans from the root's context. Recorded in DESIGN §6.
  assert.equal(parentSpanId(stepOne), root.spanID, "step-1 doStream parents under the root");
  assert.equal(parentSpanId(stepTwo), root.spanID, "step-2 doStream parents under the root");
  assert.equal(parentSpanId(toolCall), root.spanID, "toolCall parents under the root (v6)");
  // The tool still belongs to step 1 temporally.
  assert.ok(
    toolCall.startTime >= stepOne.startTime &&
      toolCall.startTime <= stepOne.startTime + stepOne.duration,
    "toolCall starts within step-1's window",
  );

  // Step 1 must be the tool-call step.
  assert.ok(
    String(tagRecord(stepOne)["gen_ai.response.finish_reasons"] ?? "").includes("tool"),
    "step-1 finish_reasons indicate a tool call",
  );

  // Both steps carry the GenAI attrs the query contract needs.
  for (const [label, span] of [
    ["step-1", stepOne],
    ["step-2", stepTwo],
  ] as const) {
    const attrs = tagRecord(span);
    assert.notEqual(attrs["gen_ai.request.model"], undefined, `${label}: gen_ai.request.model`);
    assert.notEqual(
      attrs["gen_ai.usage.input_tokens"],
      undefined,
      `${label}: gen_ai.usage.input_tokens`,
    );
  }

  // Timestamps sane (Jaeger times are microseconds).
  const endOf = (span: JaegerSpan): number => span.startTime + span.duration;
  assert.ok(root.startTime <= stepOne.startTime, "root starts before step 1");
  assert.ok(endOf(root) >= endOf(stepTwo), "root outlives step 2");
  assert.ok(stepTwo.startTime >= endOf(toolCall), "step 2 starts after the tool call ends");

  return { traceId: root.traceID, root, doStreams: [stepOne, stepTwo], toolCall };
}
