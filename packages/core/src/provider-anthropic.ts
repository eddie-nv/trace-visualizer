import type { Usage } from "./manual.js";
import {
  asFiniteNumber,
  asNonEmptyString,
  isRecord,
  tolerantJsonParse,
  type ParsedEventAccumulator,
  type ParsedRequest,
  type ParsedResponse,
  type ProviderAdapter,
  type StreamAccumulator,
} from "./provider-types.js";
import { formatSystemInstructions } from "./span-attrs.js";
import type { SseEvent } from "./sse.js";

const ANTHROPIC_HOST = "api.anthropic.com";
const MESSAGES_PATH = "/v1/messages";

/** `POST api.anthropic.com/v1/messages` — wire format per DESIGN §3/FINDINGS §4. */
export const anthropicAdapter: ProviderAdapter = {
  providerName: "anthropic",
  matchPath: MESSAGES_PATH,

  isMatch(url, method) {
    return (
      url.protocol === "https:" &&
      method === "POST" &&
      url.hostname === ANTHROPIC_HOST &&
      url.pathname === MESSAGES_PATH
    );
  },

  parseRequest(body): ParsedRequest {
    const tools = Array.isArray(body["tools"]) ? body["tools"] : undefined;
    return {
      model: asNonEmptyString(body["model"]),
      maxTokens: asFiniteNumber(body["max_tokens"]),
      temperature: asFiniteNumber(body["temperature"]),
      topP: asFiniteNumber(body["top_p"]),
      topK: asFiniteNumber(body["top_k"]),
      messages: body["messages"],
      systemInstructions:
        body["system"] === undefined ? undefined : formatSystemInstructions(body["system"]),
      systemPromptText: systemPromptText(body["system"]),
      toolDefinitions: tools,
      toolNames: tools?.map(toolName).filter((name): name is string => name !== undefined),
    };
  },

  parseResponse(json): ParsedResponse {
    if (!isRecord(json)) {
      return {};
    }
    const stopReason = asNonEmptyString(json["stop_reason"]);
    return {
      id: asNonEmptyString(json["id"]),
      model: asNonEmptyString(json["model"]),
      finishReasons: stopReason === undefined ? undefined : [stopReason],
      usage: toUsage(json["usage"]),
      outputMessages:
        json["content"] === undefined
          ? undefined
          : [{ role: "assistant", content: json["content"] }],
    };
  },

  createStreamAccumulator(): StreamAccumulator & ParsedEventAccumulator {
    return new AnthropicStreamAccumulator();
  },
};

function toolName(tool: unknown): string | undefined {
  return isRecord(tool) ? asNonEmptyString(tool["name"]) : undefined;
}

function systemPromptText(system: unknown): string | undefined {
  if (typeof system === "string") {
    return system;
  }
  if (system === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(system);
  } catch {
    return undefined;
  }
}

function toUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return {
    inputTokens: asFiniteNumber(raw["input_tokens"]),
    outputTokens: asFiniteNumber(raw["output_tokens"]),
    cacheCreationInputTokens: asFiniteNumber(raw["cache_creation_input_tokens"]),
    cacheReadInputTokens: asFiniteNumber(raw["cache_read_input_tokens"]),
  };
}

interface ContentBlockState {
  readonly type: string;
  readonly text: string;
  readonly toolUseId?: string;
  readonly toolUseName?: string;
  readonly partialJson: string;
}

/**
 * Accumulates Anthropic SSE events (FINDINGS §4): `message_start` carries the
 * id/model and initial usage, `message_delta` the final output tokens and
 * stop reason — merged with `Object.assign` semantics like OpenLLMetry.
 */
class AnthropicStreamAccumulator implements StreamAccumulator, ParsedEventAccumulator {
  private id: string | undefined;
  private model: string | undefined;
  private stopReason: string | undefined;
  private usage: Usage | undefined;
  private blocks = new Map<number, ContentBlockState>();

  onEvent(event: SseEvent): void {
    this.onParsedEvent(tolerantJsonParse(event.data));
  }

  onParsedEvent(payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }
    switch (payload["type"]) {
      case "message_start":
        this.onMessageStart(payload["message"]);
        break;
      case "content_block_start":
        this.onContentBlockStart(payload);
        break;
      case "content_block_delta":
        this.onContentBlockDelta(payload);
        break;
      case "message_delta":
        this.onMessageDelta(payload);
        break;
      default:
        break;
    }
  }

  finish(): ParsedResponse {
    const content = [...this.blocks.entries()]
      .sort(([indexA], [indexB]) => indexA - indexB)
      .map(([, block]) => finishedBlock(block));
    return {
      id: this.id,
      model: this.model,
      finishReasons: this.stopReason === undefined ? undefined : [this.stopReason],
      usage: this.usage,
      outputMessages: content.length === 0 ? undefined : [{ role: "assistant", content }],
    };
  }

  private onMessageStart(message: unknown): void {
    if (!isRecord(message)) {
      return;
    }
    this.id = asNonEmptyString(message["id"]) ?? this.id;
    this.model = asNonEmptyString(message["model"]) ?? this.model;
    this.mergeUsage(message["usage"]);
  }

  private onContentBlockStart(payload: Record<string, unknown>): void {
    const index = asFiniteNumber(payload["index"]);
    const block = payload["content_block"];
    if (index === undefined || !isRecord(block)) {
      return;
    }
    this.blocks.set(index, {
      type: asNonEmptyString(block["type"]) ?? "text",
      text: typeof block["text"] === "string" ? block["text"] : "",
      toolUseId: asNonEmptyString(block["id"]),
      toolUseName: asNonEmptyString(block["name"]),
      partialJson: "",
    });
  }

  private onContentBlockDelta(payload: Record<string, unknown>): void {
    const index = asFiniteNumber(payload["index"]);
    const delta = payload["delta"];
    if (index === undefined || !isRecord(delta)) {
      return;
    }
    const block = this.blocks.get(index);
    if (block === undefined) {
      return;
    }
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      this.blocks.set(index, { ...block, text: block.text + delta["text"] });
    } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
      this.blocks.set(index, { ...block, partialJson: block.partialJson + delta["partial_json"] });
    }
  }

  private onMessageDelta(payload: Record<string, unknown>): void {
    const delta = payload["delta"];
    if (isRecord(delta)) {
      this.stopReason = asNonEmptyString(delta["stop_reason"]) ?? this.stopReason;
    }
    this.mergeUsage(payload["usage"]);
  }

  private mergeUsage(raw: unknown): void {
    const next = toUsage(raw);
    if (next === undefined) {
      return;
    }
    this.usage = { ...this.usage, ...definedFields(next) };
  }
}

function finishedBlock(block: ContentBlockState): unknown {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.toolUseId,
      name: block.toolUseName,
      input: tryParseJson(block.partialJson),
    };
  }
  return { type: block.type, text: block.text };
}

function tryParseJson(text: string): unknown {
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function definedFields(usage: Usage): Partial<Usage> {
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    ...(usage.cacheCreationInputTokens === undefined
      ? {}
      : { cacheCreationInputTokens: usage.cacheCreationInputTokens }),
    ...(usage.cacheReadInputTokens === undefined
      ? {}
      : { cacheReadInputTokens: usage.cacheReadInputTokens }),
  };
}
