/**
 * Test F criteria — MCP + multi-participant live tool call (M12).
 *
 * Five assertions that must all pass for Test F to be green:
 *
 *   F1: Tool participant appears as a new column after initial two-column render.
 *   F2: No existing arrows or nodes moved when the tool column was inserted.
 *   F3: Clicking the dashed return arrow opens the detail panel with gen_ai.usage tokens.
 *   F4: MCP get_span returns code.function.name for the tool span.
 *   F5: MCP get_agent_context returns the file containing the tool implementation.
 */

export interface Evidence {
  readonly criterion: string;
  readonly detail: string;
}

export interface McpConversation {
  participants: string[];
  arrows: Array<{
    from: string;
    to: string;
    operation: string;
    spanId: string;
  }>;
  complete: boolean;
}

export interface McpSpan {
  spanId: string;
  name: string;
  service: string;
  attributes: Record<string, string | number | boolean>;
}

export interface McpAgentContext {
  agentId: string;
  files: string[];
  functions: string[];
}

/**
 * F1: Tool participant appears as a third column in get_conversation output.
 *
 * The initial render has the LLM caller + the AI service. After a tool call
 * mid-conversation, the tool participant must appear in the participants list.
 */
export function assertToolColumnAdded(
  conv: McpConversation,
  toolServiceName: string,
): Evidence {
  if (!conv.participants.includes(toolServiceName)) {
    throw new Error(
      `F1 FAIL: tool participant "${toolServiceName}" not in participants list: ${JSON.stringify(conv.participants)}`,
    );
  }
  const idx = conv.participants.indexOf(toolServiceName);
  if (idx < 2) {
    throw new Error(
      `F1 FAIL: tool participant "${toolServiceName}" appeared at index ${idx}, expected >= 2 (third column)`,
    );
  }
  return {
    criterion: "F1: tool column added",
    detail: `"${toolServiceName}" at participants[${idx}] — ${conv.participants.length} total`,
  };
}

/**
 * F2: Pre-tool arrows remain in place after the tool column was added.
 *
 * Checks that all arrows appearing before the tool call still exist in
 * the final conversation (no arrow was removed or reordered).
 */
export function assertNoExistingArrowsMoved(
  convBefore: Pick<McpConversation, "arrows">,
  convAfter: McpConversation,
): Evidence {
  const afterSpanIds = new Set(convAfter.arrows.map((a) => a.spanId));
  const missing = convBefore.arrows.filter((a) => !afterSpanIds.has(a.spanId));
  if (missing.length > 0) {
    throw new Error(
      `F2 FAIL: ${missing.length} pre-tool arrow(s) missing after tool column insert: ${JSON.stringify(missing.map((a) => a.spanId))}`,
    );
  }
  return {
    criterion: "F2: no existing arrows moved",
    detail: `all ${convBefore.arrows.length} pre-tool arrow(s) still present`,
  };
}

/**
 * F3: Tool return span has gen_ai.usage output_tokens attribute.
 *
 * The detail panel (and MCP get_span) should expose usage token counts
 * recorded by our instrumentation on the tool call response.
 */
export function assertToolSpanHasTokens(span: McpSpan): Evidence {
  const outputTokens = span.attributes["gen_ai.usage.output_tokens"];
  if (outputTokens === undefined) {
    throw new Error(
      `F3 FAIL: span "${span.spanId}" (${span.name}) has no gen_ai.usage.output_tokens attribute`,
    );
  }
  return {
    criterion: "F3: tool span has gen_ai.usage.output_tokens",
    detail: `span "${span.name}" — output_tokens=${outputTokens}`,
  };
}

/**
 * F4: MCP get_span returns code.function.name for the tool span.
 */
export function assertSpanHasCodeFunction(span: McpSpan): Evidence {
  const fn = span.attributes["code.function.name"] ?? span.attributes["code.function"];
  if (!fn) {
    throw new Error(
      `F4 FAIL: span "${span.spanId}" (${span.name}) has no code.function.name attribute`,
    );
  }
  return {
    criterion: "F4: tool span has code.function.name",
    detail: `span "${span.name}" — code.function.name="${fn}"`,
  };
}

/**
 * F5: MCP get_agent_context returns the file containing the tool implementation.
 */
export function assertAgentContextHasFile(ctx: McpAgentContext): Evidence {
  if (ctx.files.length === 0) {
    throw new Error(
      `F5 FAIL: get_agent_context("${ctx.agentId}") returned no files — code.file.path attributes may be missing`,
    );
  }
  return {
    criterion: "F5: agent context has source file",
    detail: `agent "${ctx.agentId}" — files: ${ctx.files.join(", ")}`,
  };
}
