import { describe, expect, it } from "vitest";
import { ATTR, CONTENT_ATTRIBUTES } from "@agentgraph/core";

describe("ATTR", () => {
  it("uses the GenAI semconv >=1.40 attribute names", () => {
    // Arrange / Act — constant exports

    // Assert
    expect(ATTR.PROVIDER_NAME).toBe("gen_ai.provider.name");
    expect(ATTR.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(ATTR.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(ATTR.REQUEST_MAX_TOKENS).toBe("gen_ai.request.max_tokens");
    expect(ATTR.REQUEST_TEMPERATURE).toBe("gen_ai.request.temperature");
    expect(ATTR.REQUEST_TOP_P).toBe("gen_ai.request.top_p");
    expect(ATTR.REQUEST_TOP_K).toBe("gen_ai.request.top_k");
    expect(ATTR.REQUEST_FREQUENCY_PENALTY).toBe("gen_ai.request.frequency_penalty");
    expect(ATTR.REQUEST_PRESENCE_PENALTY).toBe("gen_ai.request.presence_penalty");
    expect(ATTR.RESPONSE_MODEL).toBe("gen_ai.response.model");
    expect(ATTR.RESPONSE_ID).toBe("gen_ai.response.id");
    expect(ATTR.RESPONSE_FINISH_REASONS).toBe("gen_ai.response.finish_reasons");
    expect(ATTR.USAGE_INPUT_TOKENS).toBe("gen_ai.usage.input_tokens");
    expect(ATTR.USAGE_OUTPUT_TOKENS).toBe("gen_ai.usage.output_tokens");
    expect(ATTR.USAGE_CACHE_CREATION_INPUT_TOKENS).toBe("gen_ai.usage.cache_creation.input_tokens");
    expect(ATTR.USAGE_CACHE_READ_INPUT_TOKENS).toBe("gen_ai.usage.cache_read.input_tokens");
    expect(ATTR.INPUT_MESSAGES).toBe("gen_ai.input.messages");
    expect(ATTR.SYSTEM_INSTRUCTIONS).toBe("gen_ai.system_instructions");
    expect(ATTR.TOOL_DEFINITIONS).toBe("gen_ai.tool.definitions");
    expect(ATTR.OUTPUT_MESSAGES).toBe("gen_ai.output.messages");
    expect(ATTR.GEN_AI_CONVERSATION_ID).toBe("gen_ai.conversation.id");
  });

  it("does not include the non-standard total_tokens attribute", () => {
    // DESIGN §2.1 — consumers sum input+output instead.
    expect(Object.values(ATTR)).not.toContain("gen_ai.usage.total_tokens");
  });

  it("namespaces AgentGraph attributes under agentgraph.*", () => {
    expect(ATTR.AGENT_ID).toBe("agentgraph.agent.id");
    expect(ATTR.AGENT_FINGERPRINT).toBe("agentgraph.agent.fingerprint");
    expect(ATTR.CONVERSATION_ID).toBe("agentgraph.conversation.id");
    expect(ATTR.CHANNEL_TYPE).toBe("agentgraph.channel.type");
  });
});

describe("ATTR code location constants (R6)", () => {
  it("defines OTel semconv code attribute names", () => {
    expect(ATTR.CODE_FILE).toBe("code.file.path");
    expect(ATTR.CODE_LINE).toBe("code.line.number");
    expect(ATTR.CODE_FUNCTION).toBe("code.function.name");
  });
});

describe("CONTENT_ATTRIBUTES", () => {
  it("contains exactly the four content-gated attributes", () => {
    // DESIGN §4 — gating drops only these; usage/model/finish_reasons stay.
    expect([...CONTENT_ATTRIBUTES].sort()).toEqual([
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.definitions",
    ]);
  });
});
