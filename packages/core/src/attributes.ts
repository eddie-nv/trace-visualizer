/**
 * Span attribute names — OTel GenAI semconv ≥1.40 plus the `agentgraph.*`
 * namespace (DESIGN §2).
 *
 * Deliberately excludes `gen_ai.usage.total_tokens` (non-standard, DESIGN
 * §2.1) — consumers sum input + output tokens instead.
 *
 * Not every constant is emitted yet: `RESPONSE_ID` lands with the fetch hook
 * (M2) and the `agentgraph.*` namespace is stamped by the SDK's onStart
 * processor (M3, DESIGN §2.2). They are declared here so the schema has a
 * single source of truth.
 */
export const ATTR = {
  PROVIDER_NAME: "gen_ai.provider.name",
  OPERATION_NAME: "gen_ai.operation.name",
  REQUEST_MODEL: "gen_ai.request.model",
  REQUEST_MAX_TOKENS: "gen_ai.request.max_tokens",
  REQUEST_TEMPERATURE: "gen_ai.request.temperature",
  REQUEST_TOP_P: "gen_ai.request.top_p",
  REQUEST_TOP_K: "gen_ai.request.top_k",
  REQUEST_FREQUENCY_PENALTY: "gen_ai.request.frequency_penalty",
  REQUEST_PRESENCE_PENALTY: "gen_ai.request.presence_penalty",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation.input_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  INPUT_MESSAGES: "gen_ai.input.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  GEN_AI_CONVERSATION_ID: "gen_ai.conversation.id",
  /** OTel semconv code location attributes — stamped on every shim-emitted span (DESIGN §M8 R6). */
  CODE_FILE: "code.file.path",
  CODE_LINE: "code.line.number",
  CODE_FUNCTION: "code.function.name",
  AGENT_ID: "agentgraph.agent.id",
  AGENT_FINGERPRINT: "agentgraph.agent.fingerprint",
  CONVERSATION_ID: "agentgraph.conversation.id",
  CHANNEL_TYPE: "agentgraph.channel.type",
  /** Visible degrade marker — set when an emission path could not fully report. */
  WARN: "agentgraph.warn",
} as const;

/** The attribute names dropped when content capture is off (DESIGN §4). */
export type ContentAttributeKey =
  | typeof ATTR.INPUT_MESSAGES
  | typeof ATTR.SYSTEM_INSTRUCTIONS
  | typeof ATTR.TOOL_DEFINITIONS
  | typeof ATTR.OUTPUT_MESSAGES;

/**
 * Exactly the four content-gated attributes. Everything else (model, request
 * params, response id/model, finish_reasons, usage) is metadata and survives
 * `traceContent: false`.
 */
export const CONTENT_ATTRIBUTES: readonly ContentAttributeKey[] = [
  ATTR.INPUT_MESSAGES,
  ATTR.SYSTEM_INSTRUCTIONS,
  ATTR.TOOL_DEFINITIONS,
  ATTR.OUTPUT_MESSAGES,
];
