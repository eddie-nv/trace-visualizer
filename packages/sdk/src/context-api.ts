import {
  context,
  createContextKey,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
} from "@opentelemetry/api";
import { TRACER_NAME } from "@agentgraph/core";

/**
 * Context keys read by the stamping processor (DESIGN §3.5). `withAgent` /
 * `withConversation` set them; every span started inside picks them up.
 */
export const AGENT_ID_KEY = createContextKey("agentgraph.agent_id");
export const CONVERSATION_ID_KEY = createContextKey("agentgraph.conversation_id");
export const CHANNEL_TYPE_KEY = createContextKey("agentgraph.channel_type");

export interface WithAgentOptions {
  agentId: string;
  conversationId?: string;
  channelType?: string;
}

/**
 * Run `fn` under a `<agentId>.agent` span with the agentgraph context keys
 * set (DESIGN §3.5). Every span started inside — including tier-1 LLM spans —
 * is stamped with `agentgraph.*` by the onStart processor. For async
 * callbacks the agent span ends when the returned promise settles; errors
 * mark the span ERROR and rethrow.
 *
 * The overloads assume `fn` is uniformly sync or uniformly async — a union
 * return type (`Promise<X> | Y`) resolves to the async overload and infers a
 * surprising nested type.
 */
export function withAgent<T>(opts: string | WithAgentOptions, fn: () => Promise<T>): Promise<T>;
export function withAgent<T>(opts: string | WithAgentOptions, fn: () => T): T;
export function withAgent<T>(opts: string | WithAgentOptions, fn: () => T): T {
  const options = typeof opts === "string" ? { agentId: opts } : opts;
  if (options.agentId.trim() === "") {
    console.warn("agentgraph: withAgent called with an empty agentId; running callback unwrapped");
    return fn();
  }
  const ctx = contextWithKeys(options);
  return trace
    .getTracer(TRACER_NAME)
    .startActiveSpan(`${options.agentId}.agent`, {}, ctx, (span) => endSpanAround(span, fn));
}

/**
 * Run `fn` with the conversation id on the active context. Spans started
 * inside are stamped `agentgraph.conversation.id` / `gen_ai.conversation.id`;
 * no span of its own (DESIGN §1).
 */
export function withConversation<T>(conversationId: string, fn: () => Promise<T>): Promise<T>;
export function withConversation<T>(conversationId: string, fn: () => T): T;
export function withConversation<T>(conversationId: string, fn: () => T): T {
  return context.with(context.active().setValue(CONVERSATION_ID_KEY, conversationId), fn);
}

function contextWithKeys(options: WithAgentOptions): Context {
  const base = context.active().setValue(AGENT_ID_KEY, options.agentId);
  const withConv =
    options.conversationId === undefined
      ? base
      : base.setValue(CONVERSATION_ID_KEY, options.conversationId);
  return options.channelType === undefined
    ? withConv
    : withConv.setValue(CHANNEL_TYPE_KEY, options.channelType);
}

/**
 * End `span` when `fn` completes — after settlement for native promises.
 * Non-Promise thenables are treated as plain sync values (the span ends
 * immediately). The settled flag guards against a double end if a
 * misbehaving promise invokes callbacks synchronously.
 */
function endSpanAround<T>(span: Span, fn: () => T): T {
  let isSettled = false;
  const settleOnce = (end: () => void): void => {
    if (!isSettled) {
      isSettled = true;
      end();
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (value: unknown) => {
          settleOnce(() => span.end());
          return value;
        },
        (error: unknown) => {
          settleOnce(() => failSpan(span, error));
          throw error;
        },
      ) as T;
    }
    settleOnce(() => span.end());
    return result;
  } catch (error) {
    settleOnce(() => failSpan(span, error));
    throw error;
  }
}

function failSpan(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  span.end();
}
