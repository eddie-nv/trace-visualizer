import type { OtlpSpan } from "../receiver/otlp-types.js";
import type { SpanEntry } from "../receiver/span-store.js";
import type { InferredArrow, InferredActionNode } from "../../webview-src/store/view-model.js";

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
  | { command: "initTrace"; traceId: string; spans: ReadonlyArray<SpanEntry> }
  | { command: "appendSpan"; traceId: string; span: OtlpSpan; serviceName: string }
  | { command: "traceComplete"; traceId: string }
  | { command: "themeChange"; kind: "dark" | "light" }
  | { command: "inferredNodes"; traceId: string; nodes: ReadonlyArray<InferredArrow | InferredActionNode> };

/** Messages sent from the webview back to the extension host. */
export type WebviewToHostMessage =
  | { command: "webviewReady" }
  | { command: "spanSelected"; spanId: string }
  | { command: "participantSelected"; participantId: string }
  | { command: "openFile"; file: string; line: number; fn?: string };
