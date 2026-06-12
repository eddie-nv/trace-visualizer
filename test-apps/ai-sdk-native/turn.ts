/**
 * Test A-lite app (M7): the vercel/ai-chatbot stand-in while AI Gateway
 * credentials are unavailable (DESIGN §6 Test A). One "What's the weather"
 * turn through AI SDK v6 `streamText` with native telemetry enabled — the
 * same code path that emits ai-chatbot's spans (`ai.streamText`, two
 * `doStream` steps, `ai.toolCall`). Deliberately zero OTel and zero
 * agentgraph imports: spans flow to whatever global tracer provider the
 * host environment registered. Reads ANTHROPIC_API_KEY from env.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";

export const TURN_PROMPT = "What's the weather in San Francisco?";
export const TURN_FUNCTION_ID = "test-a-weather";
export const TURN_TOOL_NAME = "getWeather";
const TURN_MAX_STEPS = 2;

export async function runWeatherTurn(baseURL: string, model: string): Promise<string> {
  const anthropic = createAnthropic({ baseURL });
  const result = streamText({
    model: anthropic(model),
    prompt: TURN_PROMPT,
    tools: {
      [TURN_TOOL_NAME]: tool({
        description: "Get the current weather at a location",
        inputSchema: jsonSchema({
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        }),
        execute: async (input: unknown) => ({
          ...(input as Record<string, unknown>),
          temperature: 17,
          unit: "celsius",
        }),
      }),
    },
    stopWhen: stepCountIs(TURN_MAX_STEPS),
    experimental_telemetry: { isEnabled: true, functionId: TURN_FUNCTION_ID },
  });
  return result.text;
}
