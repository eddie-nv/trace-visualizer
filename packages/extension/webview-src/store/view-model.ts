export type ParticipantType = "service" | "model" | "tool" | "agent" | "cluster";

export interface Participant {
  readonly id: string;
  readonly label: string;
  readonly type: ParticipantType;
}

export interface CodePointer {
  readonly file: string;
  readonly line: number;
  readonly snippet?: string;
}

export interface ObservedArrow {
  readonly kind: "observed";
  readonly id: string;
  readonly fromParticipantId: string;
  readonly toParticipantId: string;
  readonly style: "solid" | "dashed";
  readonly label: string;
  readonly timeNs: string;
  readonly spanId: string;
}

export interface InferredArrow {
  readonly kind: "inferred";
  readonly id: string;
  readonly fromParticipantId: string;
  readonly toParticipantId: string;
  readonly style: "solid" | "dashed";
  readonly label: string;
  readonly timeNs: string;
  readonly codePointer: CodePointer;
  readonly reasoning: string;
}

export type Arrow = ObservedArrow | InferredArrow;

export interface ObservedActionNode {
  readonly kind: "observed";
  readonly id: string;
  readonly participantId: string;
  readonly label: string;
  readonly timeNs: string;
  readonly spanId: string;
}

export interface InferredActionNode {
  readonly kind: "inferred";
  readonly id: string;
  readonly participantId: string;
  readonly label: string;
  readonly timeNs: string;
  readonly codePointer: CodePointer;
  readonly reasoning: string;
}

export type ActionNode = ObservedActionNode | InferredActionNode;

export interface SpanEvent {
  readonly id: string;
  readonly name: string;
  readonly timeNs: string;
  readonly participantId: string;
  readonly spanId: string;
}

export interface Fragment {
  readonly id: string;
  readonly label: string;
  readonly memberSpanIds: ReadonlyArray<string>;
}

export interface ViewModel {
  readonly participants: ReadonlyArray<Participant>;
  readonly arrows: ReadonlyArray<Arrow>;
  readonly actionNodes: ReadonlyArray<ActionNode>;
  readonly spanEvents: ReadonlyArray<SpanEvent>;
  readonly fragments: ReadonlyArray<Fragment>;
}
