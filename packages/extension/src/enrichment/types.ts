import type { InferredArrow, InferredActionNode } from "../../webview-src/store/view-model.js";

export interface SourceFile {
  readonly serviceName: string;
  readonly path: string;
  readonly content: string;
}

export interface LlmInferredArrow {
  readonly nodeType: "arrow";
  readonly fromParticipantId: string;
  readonly toParticipantId: string;
  readonly style: "solid" | "dashed";
  readonly label: string;
  readonly timeNs: string;
  readonly codePointer: { readonly file: string; readonly line: number; readonly snippet?: string };
  readonly reasoning: string;
}

export interface LlmInferredActionNode {
  readonly nodeType: "action";
  readonly participantId: string;
  readonly label: string;
  readonly timeNs: string;
  readonly codePointer: { readonly file: string; readonly line: number; readonly snippet?: string };
  readonly reasoning: string;
}

export type LlmInferredNode = LlmInferredArrow | LlmInferredActionNode;

export interface EnrichmentResult {
  readonly traceId: string;
  readonly nodes: ReadonlyArray<InferredArrow | InferredActionNode>;
}
