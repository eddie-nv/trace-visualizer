import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OtlpSpan } from "../receiver/otlp-types.js";
import type { TracedConversation } from "../receiver/span-store.js";

export interface SpanEntry {
  readonly span: OtlpSpan;
  readonly serviceName: string;
}

export interface TraceRecord {
  readonly traceId: string;
  readonly rootSpan: OtlpSpan | undefined;
  readonly spans: ReadonlyArray<SpanEntry>;
  readonly servicesSeen: ReadonlySet<string>;
  readonly complete: boolean;
}

interface SerializedTrace {
  traceId: string;
  rootSpan: OtlpSpan | undefined;
  spans: SpanEntry[];
  servicesSeen: string[];
  complete: boolean;
}

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".agentgraph", "traces.json");

export function getStorePath(): string {
  return process.env["AGENTGRAPH_STORE_PATH"] ?? DEFAULT_STORE_PATH;
}

export function writeTraces(conversations: ReadonlyArray<TracedConversation>): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  const data: SerializedTrace[] = conversations.map((c) => ({
    traceId: c.traceId,
    rootSpan: c.rootSpan,
    spans: [...c.spans],
    servicesSeen: [...c.servicesSeen],
    complete: c.complete,
  }));
  const tmp = storePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, storePath);
}

export function readTraces(): TraceRecord[] {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) return [];
  try {
    const raw = fs.readFileSync(storePath, "utf8");
    const data = JSON.parse(raw) as SerializedTrace[];
    return data.map((d) => ({
      traceId: d.traceId,
      rootSpan: d.rootSpan,
      spans: d.spans,
      servicesSeen: new Set(d.servicesSeen),
      complete: d.complete,
    }));
  } catch {
    return [];
  }
}
