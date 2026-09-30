import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type StarConfig } from "../src/config/schema";
import { resolveModelConfig } from "../src/llm/registry";
import { streamChat } from "../src/llm/stream";

function makeConfig(models: unknown[], providers: unknown[] = []): StarConfig {
  return ConfigSchema.parse({ defaultModel: "m", models, providers });
}

describe("temperature config", () => {
  it("parses a per-model temperature and resolves it", () => {
    const config = makeConfig([{ name: "m", provider: "p", model: "x", temperature: 1 }]);
    expect(config.models[0]?.temperature).toBe(1);
    expect(resolveModelConfig(config).temperature).toBe(1);
  });

  it("accepts 0, leaves unset models undefined, and rejects negatives", () => {
    const zero = makeConfig([{ name: "m", provider: "p", model: "x", temperature: 0 }]);
    expect(resolveModelConfig(zero).temperature).toBe(0);
    const unset = makeConfig([{ name: "m", provider: "p", model: "x" }]);
    expect(resolveModelConfig(unset).temperature).toBeUndefined();
    expect(() =>
      makeConfig([{ name: "m", provider: "p", model: "x", temperature: -0.5 }]),
    ).toThrow();
  });
});

describe("streamChat temperature", () => {
  function capturingModel(captured: { temperature?: unknown }) {
    return new MockLanguageModelV1({
      doStream: async (options) => {
        captured.temperature = options.temperature;
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "hi" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
  }

  it("forwards the configured temperature to the model call", async () => {
    const captured: { temperature?: unknown } = {};
    const stream = streamChat({
      model: capturingModel(captured),
      messages: [{ role: "user", content: "hi" }],
      temperature: 1,
    });
    for await (const _ of stream) {
      // drain
    }
    expect(captured.temperature).toBe(1);
  });

  it("falls through to the SDK default when unset", async () => {
    // ai@4 defaults an unset temperature to 0 (TODO v5 in the SDK removes
    // it) and that 0 goes on the wire — which is exactly why endpoints that
    // mandate one value (kimi-for-coding) need the config key.
    const captured: { temperature?: unknown } = {};
    const stream = streamChat({
      model: capturingModel(captured),
      messages: [{ role: "user", content: "hi" }],
    });
    for await (const _ of stream) {
      // drain
    }
    expect(captured.temperature).toBe(0);
  });
});
