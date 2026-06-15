import { describe, expect, it } from "vitest";
import { colorFromString } from "./color.js";

describe("colorFromString", () => {
  it("returns a valid HSL string", () => {
    const result = colorFromString("my-service");
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it("is deterministic — same input always returns same color", () => {
    expect(colorFromString("agent-a")).toBe(colorFromString("agent-a"));
    expect(colorFromString("model-claude")).toBe(colorFromString("model-claude"));
  });

  it("returns different colors for different inputs", () => {
    expect(colorFromString("agent-a")).not.toBe(colorFromString("agent-b"));
    expect(colorFromString("svc-x")).not.toBe(colorFromString("svc-y"));
  });

  it("respects saturation and lightness overrides", () => {
    const result = colorFromString("svc", 70, 35);
    expect(result).toMatch(/^hsl\(\d+, 70%, 35%\)$/);
  });

  it("uses defaults of saturation=65 lightness=50", () => {
    const result = colorFromString("svc");
    expect(result).toMatch(/^hsl\(\d+, 65%, 50%\)$/);
  });

  it("hue is always in 0–359 range", () => {
    const inputs = ["a", "service-x", "long-service-name-with-dashes-123", "", "z"];
    for (const s of inputs) {
      const match = colorFromString(s).match(/^hsl\((\d+)/);
      expect(match).not.toBeNull();
      const hue = parseInt(match![1], 10);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});
