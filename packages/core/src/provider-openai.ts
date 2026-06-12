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
import type { SseEvent } from "./sse.js";

const OPENAI_HOST = "api.openai.com";
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const SSE_DONE_SENTINEL = "[DONE]";

/** `POST api.openai.com/v1/chat/completions` (DESIGN §3 tier 1). */
export const openaiAdapter: ProviderAdapter = {
  providerName: "openai",
  matchPath: CHAT_COMPLETIONS_PATH,

  isMatch(url, method) {
    return (
      url.protocol === "https:" &&
      method === "POST" &&
      url.hostname === OPENAI_HOST &&
      url.pathname === CHAT_COMPLETIONS_PATH
    );
  },

  parseRequest(body): ParsedRequest {
    const tools = Array.isArray(body["tools"]) ? body["tools"] : undefined;
    return {
      model: asNonEmptyString(body["model"]),
      maxTokens:
        asFiniteNumber(body["max_tokens"]) ?? asFiniteNumber(body["max_completion_tokens"]),
      temperature: asFiniteNumber(body["temperature"]),
      topP: asFiniteNumber(body["top_p"]),
      frequencyPenalty: asFiniteNumber(body["frequency_penalty"]),
      presencePenalty: asFiniteNumber(body["presence_penalty"]),
      messages: body["messages"],
      // OpenAI carries system prompts inside `messages`; they stay in
      // `gen_ai.input.messages` rather than `gen_ai.system_instructions`.
      systemPromptText: firstSystemMessageText(body["messages"]),
      toolDefinitions: tools,
      toolNames: tools?.map(toolName).filter((name): name is string => name !== undefined),
    };
  },

  parseResponse(json): ParsedResponse {
    if (!isRecord(json)) {
      return {};
    }
    const choices = Array.isArray(json["choices"]) ? json["choices"] : [];
    const finishReasons = choices
      .map((choice) => (isRecord(choice) ? asNonEmptyString(choice["finish_reason"]) : undefined))
      .filter((reason): reason is string => reason !== undefined);
    const messages = choices
      .map((choice) => (isRecord(choice) ? choice["message"] : undefined))
      .filter((message) => message !== undefined);
    return {
      id: asNonEmptyString(json["id"]),
      model: asNonEmptyString(json["model"]),
      finishReasons: finishReasons.length === 0 ? undefined : finishReasons,
      usage: toUsage(json["usage"]),
      outputMessages: messages.length === 0 ? undefined : messages,
    };
  },

  createStreamAccumulator(): StreamAccumulator & ParsedEventAccumulator {
    return new OpenAIStreamAccumulator();
  },
};

function toolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) {
    return undefined;
  }
  const fn = tool["function"];
  return isRecord(fn) ? asNonEmptyString(fn["name"]) : undefined;
}

function firstSystemMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = message["role"];
    if (role === "system" || role === "developer") {
      return typeof message["content"] === "string" ? message["content"] : undefined;
    }
  }
  return undefined;
}

function toUsage(raw: unknown): Usage | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const promptDetails = raw["prompt_tokens_details"];
  return {
    inputTokens: asFiniteNumber(raw["prompt_tokens"]),
    outputTokens: asFiniteNumber(raw["completion_tokens"]),
    cacheReadInputTokens: isRecord(promptDetails)
      ? asFiniteNumber(promptDetails["cached_tokens"])
      : undefined,
  };
}

interface ChoiceState {
  readonly role: string | undefined;
  readonly content: string;
  readonly finishReason: string | undefined;
}

/**
 * Accumulates OpenAI chat-completion chunks. Usage appears only on the final
 * chunk and only when the caller set `stream_options.include_usage`; absent
 * that, the span is emitted without usage (DESIGN Q3, deferred). Streamed
 * tool-call deltas are not reconstructed in v0.
 */
class OpenAIStreamAccumulator implements StreamAccumulator, ParsedEventAccumulator {
  private id: string | undefined;
  private model: string | undefined;
  private usage: Usage | undefined;
  private choices = new Map<number, ChoiceState>();

  onEvent(event: SseEvent): void {
    if (event.data === SSE_DONE_SENTINEL) {
      return;
    }
    this.onParsedEvent(tolerantJsonParse(event.data));
  }

  onParsedEvent(payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }
    this.id = this.id ?? asNonEmptyString(payload["id"]);
    this.model = this.model ?? asNonEmptyString(payload["model"]);
    this.usage = toUsage(payload["usage"]) ?? this.usage;
    if (Array.isArray(payload["choices"])) {
      for (const choice of payload["choices"]) {
        this.onChoice(choice);
      }
    }
  }

  finish(): ParsedResponse {
    const ordered = [...this.choices.entries()].sort(([indexA], [indexB]) => indexA - indexB);
    const finishReasons = ordered
      .map(([, choice]) => choice.finishReason)
      .filter((reason): reason is string => reason !== undefined);
    const messages = ordered.map(([, choice]) => ({
      role: choice.role ?? "assistant",
      content: choice.content,
    }));
    return {
      id: this.id,
      model: this.model,
      finishReasons: finishReasons.length === 0 ? undefined : finishReasons,
      usage: this.usage,
      outputMessages: messages.length === 0 ? undefined : messages,
    };
  }

  private onChoice(choice: unknown): void {
    if (!isRecord(choice)) {
      return;
    }
    const index = asFiniteNumber(choice["index"]);
    if (index === undefined) {
      return;
    }
    const previous = this.choices.get(index) ?? {
      role: undefined,
      content: "",
      finishReason: undefined,
    };
    const delta = isRecord(choice["delta"]) ? choice["delta"] : {};
    this.choices.set(index, {
      role: previous.role ?? asNonEmptyString(delta["role"]),
      content:
        typeof delta["content"] === "string"
          ? previous.content + delta["content"]
          : previous.content,
      finishReason: asNonEmptyString(choice["finish_reason"]) ?? previous.finishReason,
    });
  }
}
