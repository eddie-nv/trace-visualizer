import { anthropicAdapter } from "./provider-anthropic.js";
import { openaiAdapter } from "./provider-openai.js";
import type { ProviderAdapter } from "./provider-types.js";

const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter, openaiAdapter];

/**
 * TEST-ONLY: maps a provider name to an extra origin its adapter should
 * match (e.g. `{ anthropic: "http://127.0.0.1:8788" }`). Lets an E2E harness
 * point the fetch hook at a deterministic local mock of the provider wire
 * format (DESIGN §6 Test B). Never set this in production — it widens span
 * matching beyond the real provider hosts.
 */
export type MatchOriginOverrides = Readonly<Record<string, string>>;

const OVERRIDE_METHOD = "POST";

/** Returns the adapter for a matched provider endpoint, if any (DESIGN §3). */
export function matchProviderAdapter(
  url: URL,
  method: string,
  overrides?: MatchOriginOverrides,
): ProviderAdapter | undefined {
  const matched = ADAPTERS.find((adapter) => adapter.isMatch(url, method));
  if (matched !== undefined || overrides === undefined) {
    return matched;
  }
  return ADAPTERS.find(
    (adapter) =>
      overrides[adapter.providerName] === url.origin &&
      method === OVERRIDE_METHOD &&
      url.pathname === adapter.matchPath,
  );
}
