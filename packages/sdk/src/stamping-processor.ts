import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ATTR } from "@agentgraph/core";
import { AGENT_ID_KEY, CHANNEL_TYPE_KEY, CONVERSATION_ID_KEY } from "./context-api.js";

/** Process-wide values used when no context key is present (DESIGN §3.5). */
export interface StampingFallback {
  agentId?: string;
}

/**
 * onStart-wrapping processor (DESIGN §2.2, §3.5): stamps `agentgraph.*` onto
 * **every** span from the active context keys, falling back to the global
 * agentId from `init()`. Conversation ids are additionally mirrored to the
 * standard `gen_ai.conversation.id`. Everything else delegates to the
 * wrapped processor.
 */
export class StampingSpanProcessor implements SpanProcessor {
  private readonly inner: SpanProcessor;
  private readonly fallback: StampingFallback;

  constructor(inner: SpanProcessor, fallback: StampingFallback) {
    this.inner = inner;
    this.fallback = fallback;
  }

  onStart(span: Span, parentContext: Context): void {
    const agentId = stringValue(parentContext, AGENT_ID_KEY) ?? this.fallback.agentId;
    const conversationId = stringValue(parentContext, CONVERSATION_ID_KEY);
    setIfAbsent(span, ATTR.AGENT_ID, agentId);
    setIfAbsent(span, ATTR.CONVERSATION_ID, conversationId);
    setIfAbsent(span, ATTR.GEN_AI_CONVERSATION_ID, conversationId);
    setIfAbsent(span, ATTR.CHANNEL_TYPE, stringValue(parentContext, CHANNEL_TYPE_KEY));
    this.inner.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function stringValue(ctx: Context, key: symbol): string | undefined {
  const value = ctx.getValue(key);
  return typeof value === "string" ? value : undefined;
}

function setIfAbsent(span: Span, key: string, value: string | undefined): void {
  if (value !== undefined && span.attributes[key] === undefined) {
    span.setAttribute(key, value);
  }
}
