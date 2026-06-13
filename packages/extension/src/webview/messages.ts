import type { OtlpSpan } from "../receiver/otlp-types.js";

/** Messages sent from the extension host to the webview. */
export type HostToWebviewMessage =
  | { command: "initTrace"; traceId: string; spans: ReadonlyArray<{ span: OtlpSpan; serviceName: string }> }
  | { command: "appendSpan"; traceId: string; span: OtlpSpan; serviceName: string }
  | { command: "traceComplete"; traceId: string };

/** Messages sent from the webview back to the extension host. */
export type WebviewToHostMessage =
  | { command: "webviewReady" }
  | { command: "spanSelected"; spanId: string }
  | { command: "participantSelected"; participantId: string }
  | { command: "openFile"; file: string; line: number; fn?: string };
