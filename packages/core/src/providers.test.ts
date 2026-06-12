import { describe, expect, it } from "vitest";
import { matchProviderAdapter } from "./providers.js";

const POST = "POST";
const ANTHROPIC_URL = new URL("https://api.anthropic.com/v1/messages");
const OPENAI_URL = new URL("https://api.openai.com/v1/chat/completions");
const MOCK_ORIGIN = "http://127.0.0.1:8788";

describe("matchProviderAdapter", () => {
  it("matches the real anthropic endpoint", () => {
    expect(matchProviderAdapter(ANTHROPIC_URL, POST)?.providerName).toBe("anthropic");
  });

  it("matches the real openai endpoint", () => {
    expect(matchProviderAdapter(OPENAI_URL, POST)?.providerName).toBe("openai");
  });

  it("does not match a local origin without an override", () => {
    const url = new URL(`${MOCK_ORIGIN}/v1/messages`);

    expect(matchProviderAdapter(url, POST)).toBeUndefined();
  });

  it("matches an overridden origin on the provider path", () => {
    // Arrange
    const url = new URL(`${MOCK_ORIGIN}/v1/messages`);

    // Act
    const adapter = matchProviderAdapter(url, POST, { anthropic: MOCK_ORIGIN });

    // Assert
    expect(adapter?.providerName).toBe("anthropic");
  });

  it("matches an overridden openai origin on its own path", () => {
    const url = new URL(`${MOCK_ORIGIN}/v1/chat/completions`);

    const adapter = matchProviderAdapter(url, POST, { openai: MOCK_ORIGIN });

    expect(adapter?.providerName).toBe("openai");
  });

  it("requires the override origin to match exactly", () => {
    const url = new URL("http://127.0.0.1:9999/v1/messages");

    expect(matchProviderAdapter(url, POST, { anthropic: MOCK_ORIGIN })).toBeUndefined();
  });

  it("does not match other paths on an overridden origin", () => {
    const url = new URL(`${MOCK_ORIGIN}/healthz`);

    expect(matchProviderAdapter(url, POST, { anthropic: MOCK_ORIGIN })).toBeUndefined();
  });

  it("does not match non-POST methods on an overridden origin", () => {
    const url = new URL(`${MOCK_ORIGIN}/v1/messages`);

    expect(matchProviderAdapter(url, "GET", { anthropic: MOCK_ORIGIN })).toBeUndefined();
  });

  it("does not cross-match providers under an override", () => {
    // The anthropic override must not make the openai path match.
    const url = new URL(`${MOCK_ORIGIN}/v1/chat/completions`);

    expect(matchProviderAdapter(url, POST, { anthropic: MOCK_ORIGIN })).toBeUndefined();
  });

  it("keeps matching the real host while an override is active", () => {
    const adapter = matchProviderAdapter(ANTHROPIC_URL, POST, { anthropic: MOCK_ORIGIN });

    expect(adapter?.providerName).toBe("anthropic");
  });
});
