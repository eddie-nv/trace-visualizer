import { anthropicAdapter } from "./provider-anthropic.js";
import { openaiAdapter } from "./provider-openai.js";
import type { ProviderAdapter } from "./provider-types.js";

const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter, openaiAdapter];

/** Returns the adapter for a matched provider endpoint, if any (DESIGN §3). */
export function matchProviderAdapter(url: URL, method: string): ProviderAdapter | undefined {
  return ADAPTERS.find((adapter) => adapter.isMatch(url, method));
}
