import { createHash } from "node:crypto";

/** Request-visible signals that identify an unconfigured agent. */
export interface FingerprintInput {
  provider: string;
  model: string;
  toolNames?: readonly string[];
  systemPrompt?: string;
}

const SYSTEM_PROMPT_PREFIX_LENGTH = 256;
const FINGERPRINT_HEX_LENGTH = 16;
const FIELD_SEPARATOR = "\u0000";

/**
 * ⚠️ Provisional (DESIGN Q4): stable hash of (provider, model, sorted tool
 * names, first {@link SYSTEM_PROMPT_PREFIX_LENGTH} chars of the system
 * prompt), used as `agentgraph.agent.fingerprint` to cluster unconfigured
 * agents. The definition needs real-traffic validation; treat the value as
 * opaque and do not persist assumptions about its derivation.
 */
export function computeAgentFingerprint(input: FingerprintInput): string {
  if (typeof input.provider !== "string" || input.provider.length === 0) {
    throw new TypeError("computeAgentFingerprint: provider must be a non-empty string");
  }
  if (typeof input.model !== "string" || input.model.length === 0) {
    throw new TypeError("computeAgentFingerprint: model must be a non-empty string");
  }

  const sortedToolNames = [...(input.toolNames ?? [])].sort();
  const systemPromptPrefix = (input.systemPrompt ?? "").slice(0, SYSTEM_PROMPT_PREFIX_LENGTH);
  const canonical = [
    input.provider,
    input.model,
    sortedToolNames.join(","),
    systemPromptPrefix,
  ].join(FIELD_SEPARATOR);

  return createHash("sha256").update(canonical).digest("hex").slice(0, FINGERPRINT_HEX_LENGTH);
}
