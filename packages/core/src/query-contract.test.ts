import { describe, expect, it } from "vitest";
import { isLLMCall, provider, usage } from "./query-contract.js";

/** Our shim's spans (semconv ≥1.40, what core emits at every tier). */
const SHIM_ATTRS = {
  "gen_ai.provider.name": "anthropic",
  "gen_ai.operation.name": "chat",
  "gen_ai.request.model": "claude-sonnet-4-6",
  "gen_ai.usage.input_tokens": 17,
  "gen_ai.usage.output_tokens": 42,
  "gen_ai.input.messages": "[…]",
} as const;

/** AI SDK v6 `ai.streamText.doStream` span (FINDINGS §1.4: gen_ai.system, no provider.name). */
const AI_SDK_V6_DOSTREAM_ATTRS = {
  "operation.name": "ai.streamText.doStream test-a-weather",
  "ai.operationId": "ai.streamText.doStream",
  "ai.prompt.messages": "[…]",
  "gen_ai.system": "anthropic.messages",
  "gen_ai.request.model": "claude-sonnet-4-6",
  "gen_ai.response.id": "msg_01",
  "gen_ai.usage.input_tokens": 10,
  "gen_ai.usage.output_tokens": 5,
} as const;

/** AI SDK v7 `@ai-sdk/otel` chat span (provider.name like semconv). */
const AI_SDK_V7_CHAT_ATTRS = {
  "gen_ai.provider.name": "anthropic",
  "gen_ai.request.model": "claude-sonnet-4-6",
  "gen_ai.usage.input_tokens": 10,
  "gen_ai.usage.output_tokens": 5,
} as const;

/** AI SDK root span: model info in `ai.*` namespace only — NOT an LLM call. */
const AI_SDK_ROOT_ATTRS = {
  "operation.name": "ai.streamText test-a-weather",
  "ai.operationId": "ai.streamText",
  "ai.model.id": "claude-sonnet-4-6",
  "ai.model.provider": "anthropic.messages",
  "ai.usage.inputTokens": 10,
  "ai.usage.outputTokens": 5,
} as const;

/** AI SDK tool span — NOT an LLM call. */
const AI_SDK_TOOLCALL_ATTRS = {
  "operation.name": "ai.toolCall test-a-weather",
  "ai.toolCall.name": "getWeather",
  "ai.toolCall.id": "toolu_01",
} as const;

describe("isLLMCall (DESIGN §2.3)", () => {
  it("selects spans from all three sources via one predicate", () => {
    expect(isLLMCall(SHIM_ATTRS)).toBe(true);
    expect(isLLMCall(AI_SDK_V6_DOSTREAM_ATTRS)).toBe(true);
    expect(isLLMCall(AI_SDK_V7_CHAT_ATTRS)).toBe(true);
  });

  it("rejects AI SDK root and toolCall spans (zero false positives)", () => {
    expect(isLLMCall(AI_SDK_ROOT_ATTRS)).toBe(false);
    expect(isLLMCall(AI_SDK_TOOLCALL_ATTRS)).toBe(false);
  });

  it("requires gen_ai.request.model", () => {
    expect(isLLMCall({ "gen_ai.usage.input_tokens": 5 })).toBe(false);
  });

  it("requires at least one usage token count", () => {
    expect(isLLMCall({ "gen_ai.request.model": "m" })).toBe(false);
    expect(isLLMCall({ "gen_ai.request.model": "m", "gen_ai.usage.input_tokens": 0 })).toBe(true);
    expect(isLLMCall({ "gen_ai.request.model": "m", "gen_ai.usage.output_tokens": 3 })).toBe(true);
  });
});

describe("provider (DESIGN §2.3 — the single documented coalesce)", () => {
  it("reads gen_ai.provider.name first", () => {
    expect(provider(SHIM_ATTRS)).toBe("anthropic");
  });

  it("falls back to gen_ai.system for AI SDK v6 spans", () => {
    expect(provider(AI_SDK_V6_DOSTREAM_ATTRS)).toBe("anthropic.messages");
  });

  it("prefers provider.name when both are present", () => {
    expect(
      provider({ "gen_ai.provider.name": "anthropic", "gen_ai.system": "legacy" }),
    ).toBe("anthropic");
  });

  it("returns undefined when neither is a non-empty string", () => {
    expect(provider({})).toBeUndefined();
    expect(provider({ "gen_ai.provider.name": "" })).toBeUndefined();
    expect(provider({ "gen_ai.system": 42 })).toBeUndefined();
  });
});

describe("usage (DESIGN §2.3 — identical key in all three sources)", () => {
  it("extracts numeric token counts", () => {
    expect(usage(SHIM_ATTRS)).toEqual({ inputTokens: 17, outputTokens: 42 });
  });

  it("accepts numeric strings (Jaeger may stringify int64 tags)", () => {
    const extracted = usage({
      "gen_ai.usage.input_tokens": "17",
      "gen_ai.usage.output_tokens": "42",
    });

    expect(extracted).toEqual({ inputTokens: 17, outputTokens: 42 });
  });

  it("omits fields that are absent or non-numeric", () => {
    expect(usage({ "gen_ai.usage.input_tokens": 17 })).toEqual({ inputTokens: 17 });
    expect(usage({ "gen_ai.usage.output_tokens": "not a number" })).toEqual({});
    expect(usage({})).toEqual({});
  });
});
