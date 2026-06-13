export interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
}

export interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

export interface OtlpEvent {
  name: string;
  timeUnixNano: string;
  attributes?: OtlpAttribute[];
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
  events?: OtlpEvent[];
}

export interface OtlpResource {
  attributes?: OtlpAttribute[];
}

export interface OtlpScopeSpan {
  spans: OtlpSpan[];
}

export interface OtlpResourceSpan {
  resource?: OtlpResource;
  scopeSpans: OtlpScopeSpan[];
}

export interface OtlpEnvelope {
  resourceSpans: OtlpResourceSpan[];
}

export function getStringAttr(attrs: OtlpAttribute[] | undefined, key: string): string | undefined {
  return attrs?.find((a) => a.key === key)?.value?.stringValue;
}
