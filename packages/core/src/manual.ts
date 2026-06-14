import { context, SpanKind, trace, type Span } from "@opentelemetry/api";
import { ATTR } from "./attributes.js";
import { captureCallerFrame } from "./caller-frame.js";
import { shouldSendContent } from "./content-gating.js";
import {
  applyUsage,
  formatSystemInstructions,
  recordSpanError,
  setCallerAttributes,
  setStringAttribute,
} from "./span-attrs.js";
import { TRACER_NAME } from "./tracer.js";

export type LLMOperation = "chat" | "text_completion";

const LLM_OPERATIONS: readonly LLMOperation[] = ["chat", "text_completion"];

export interface LLMCallAttributes {
  provider: string;
  operation: LLMOperation;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface LLMSpanRequest {
  readonly model: string;
  /** Serialized verbatim into `gen_ai.input.messages` when content is on. */
  readonly messages: readonly unknown[];
  /** A plain string is wrapped as `[{ type: "text", content }]` (semconv parts). */
  readonly system?: unknown;
}

export interface LLMSpanResponse {
  readonly model?: string;
  readonly usage?: Readonly<Usage>;
  readonly messages?: readonly unknown[];
  readonly finishReasons?: readonly string[];
}

/**
 * Returned by {@link LLMSpan.reportRequest}; response can only follow request.
 *
 * Call `reportResponse` before the `withLLMCall` callback settles — the span
 * ends when the callback does, and attributes written to an ended span are
 * dropped by the OTel SDK.
 */
export interface LLMSpanAfterRequest {
  reportResponse(res: LLMSpanResponse): void;
}

/**
 * Handle passed to the `withLLMCall` callback. `reportRequest` must be called
 * (it names the span `"<operation> <model>"` and sets `gen_ai.request.model`,
 * which the DESIGN §2.3 query contract depends on); spans that end without it
 * are flagged with an `agentgraph.warn` attribute.
 */
export interface LLMSpan {
  reportRequest(req: LLMSpanRequest): LLMSpanAfterRequest;
}

const WARN_ATTRIBUTE = ATTR.WARN;

/**
 * Manual instrumentation escape hatch (DESIGN §1). Emits a CLIENT span via
 * the global tracer, makes it active inside `fn`, and respects content
 * gating on every content attribute — unlike the OpenLLMetry manual API it
 * is modeled on.
 *
 * Errors thrown (or rejected) by `fn` are recorded on the span, the span is
 * marked ERROR and ended, and the original error is rethrown.
 */
export function withLLMCall<T>(
  attrs: LLMCallAttributes,
  fn: (span: LLMSpan) => T | Promise<T>,
): Promise<T> {
  // Capture synchronously before any awaits so the stack still shows the call site.
  const callerFrame = captureCallerFrame();
  validateCallAttributes(attrs);
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(
    attrs.operation,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR.PROVIDER_NAME]: attrs.provider,
        [ATTR.OPERATION_NAME]: attrs.operation,
      },
    },
    async (span) => {
      setCallerAttributes(span, callerFrame);
      let isRequestReported = false;
      const llmSpan: LLMSpan = {
        reportRequest(req) {
          // Mark intent before validating so a rejected reportRequest does not
          // also stamp the misleading "reportRequest not called" warning.
          isRequestReported = true;
          applyRequest(span, attrs.operation, req);
          return {
            reportResponse(res) {
              applyResponse(span, res);
            },
          };
        },
      };

      try {
        return await fn(llmSpan);
      } catch (error) {
        recordSpanError(span, error);
        throw error;
      } finally {
        if (!isRequestReported) {
          span.setAttribute(WARN_ATTRIBUTE, "reportRequest not called");
        }
        span.end();
      }
    },
  );
}

function validateCallAttributes(attrs: LLMCallAttributes): void {
  if (typeof attrs.provider !== "string" || attrs.provider.length === 0) {
    throw new TypeError("withLLMCall: provider must be a non-empty string");
  }
  if (!LLM_OPERATIONS.includes(attrs.operation)) {
    throw new TypeError(`withLLMCall: operation must be one of: ${LLM_OPERATIONS.join(", ")}`);
  }
}

function applyRequest(span: Span, operation: LLMOperation, req: LLMSpanRequest): void {
  if (typeof req.model !== "string" || req.model.length === 0) {
    throw new TypeError("reportRequest: model must be a non-empty string");
  }
  if (!Array.isArray(req.messages)) {
    throw new TypeError("reportRequest: messages must be an array");
  }

  span.updateName(`${operation} ${req.model}`);
  span.setAttribute(ATTR.REQUEST_MODEL, req.model);

  if (!shouldSendContent(undefined, context.active())) {
    return;
  }
  span.setAttribute(ATTR.INPUT_MESSAGES, JSON.stringify(req.messages));
  if (req.system !== undefined) {
    span.setAttribute(
      ATTR.SYSTEM_INSTRUCTIONS,
      JSON.stringify(formatSystemInstructions(req.system)),
    );
  }
}

function applyResponse(span: Span, res: LLMSpanResponse): void {
  setStringAttribute(span, ATTR.RESPONSE_MODEL, res.model);
  if (res.finishReasons !== undefined) {
    span.setAttribute(ATTR.RESPONSE_FINISH_REASONS, [...res.finishReasons]);
  }
  applyUsage(span, res.usage);

  if (res.messages !== undefined && shouldSendContent(undefined, context.active())) {
    span.setAttribute(ATTR.OUTPUT_MESSAGES, JSON.stringify(res.messages));
  }
}
