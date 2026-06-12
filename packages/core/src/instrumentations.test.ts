import { describe, expect, it } from "vitest";
import { AnthropicInstrumentation, OpenAIInstrumentation } from "./instrumentations.js";

type AnyFn = (...args: unknown[]) => unknown;

interface ModuleDefinitionLike {
  name: string;
  patch?: (exports: unknown, version?: string) => unknown;
  unpatch?: (exports: unknown, version?: string) => unknown;
}

function anthropicModule(): { module: Record<string, unknown>; create: () => AnyFn } {
  class Messages {
    async create(): Promise<unknown> {
      return { id: "msg" };
    }
  }
  class Anthropic {
    static Messages = Messages;
  }
  return {
    module: { Anthropic, default: Anthropic },
    create: () => Messages.prototype.create as AnyFn,
  };
}

function openaiModule(): { module: Record<string, unknown>; create: () => AnyFn } {
  class Completions {
    async create(): Promise<unknown> {
      return { id: "chatcmpl" };
    }
  }
  class Chat {
    static Completions = Completions;
  }
  class OpenAI {
    static Chat = Chat;
  }
  return {
    module: { OpenAI, default: OpenAI },
    create: () => Completions.prototype.create as AnyFn,
  };
}

function definitionOf(instrumentation: object): ModuleDefinitionLike {
  // init() is protected; bracket access is the sanctioned test loophole
  const definition = (instrumentation as Record<string, () => unknown>)["init"]!() as
    | ModuleDefinitionLike
    | ModuleDefinitionLike[];
  return Array.isArray(definition) ? definition[0]! : definition;
}

describe("AnthropicInstrumentation (tier 3 definition)", () => {
  it("targets the @anthropic-ai/sdk module", () => {
    const instrumentation = new AnthropicInstrumentation({ enabled: false });

    expect(definitionOf(instrumentation).name).toBe("@anthropic-ai/sdk");
  });

  it("patch wraps Messages.prototype.create and unpatch restores it", () => {
    // Arrange
    const instrumentation = new AnthropicInstrumentation({ enabled: false });
    const definition = definitionOf(instrumentation);
    const { module, create } = anthropicModule();
    const original = create();

    // Act / Assert
    definition.patch?.(module);
    expect(create()).not.toBe(original);

    definition.unpatch?.(module);
    expect(create()).toBe(original);
  });

  it("manuallyInstrument wraps a directly-provided module (no loader hooks)", () => {
    const instrumentation = new AnthropicInstrumentation({ enabled: false });
    const { module, create } = anthropicModule();
    const original = create();

    instrumentation.manuallyInstrument(module);

    expect(create()).not.toBe(original);
  });
});

describe("OpenAIInstrumentation (tier 3 definition)", () => {
  it("targets the openai module", () => {
    const instrumentation = new OpenAIInstrumentation({ enabled: false });

    expect(definitionOf(instrumentation).name).toBe("openai");
  });

  it("patch wraps Chat.Completions.prototype.create and unpatch restores it", () => {
    const instrumentation = new OpenAIInstrumentation({ enabled: false });
    const definition = definitionOf(instrumentation);
    const { module, create } = openaiModule();
    const original = create();

    definition.patch?.(module);
    expect(create()).not.toBe(original);

    definition.unpatch?.(module);
    expect(create()).toBe(original);
  });

  it("manuallyInstrument wraps a directly-provided module", () => {
    const instrumentation = new OpenAIInstrumentation({ enabled: false });
    const { module, create } = openaiModule();
    const original = create();

    instrumentation.manuallyInstrument(module);

    expect(create()).not.toBe(original);
  });
});
