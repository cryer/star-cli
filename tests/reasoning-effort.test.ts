import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { ConfigSchema, type StarConfig } from "../src/config/schema";
import { reasoningEffortMetadata } from "../src/llm/provider";
import { streamChat } from "../src/llm/stream";

function makeConfig(models: unknown[], providers: unknown[] = []): StarConfig {
  return ConfigSchema.parse({ defaultModel: "m", models, providers });
}

describe("reasoningEffort config", () => {
  it("parses a per-model reasoningEffort", () => {
    const config = makeConfig([{ name: "m", provider: "p", model: "x", reasoningEffort: "high" }]);
    expect(config.models[0]?.reasoningEffort).toBe("high");
  });

  it("rejects an unknown effort level", () => {
    expect(() =>
      makeConfig([{ name: "m", provider: "p", model: "x", reasoningEffort: "ultra" }]),
    ).toThrow();
  });
});

describe("reasoningEffortMetadata", () => {
  const providers = [
    { name: "compat", protocol: "openai-compatible", baseURL: "http://x", apiKey: "k" },
    { name: "resp", protocol: "openai-responses", baseURL: "http://x", apiKey: "k" },
    { name: "claude", protocol: "anthropic", baseURL: "http://x", apiKey: "k" },
  ];

  it("keys metadata by the provider name for openai-compatible", () => {
    const config = makeConfig(
      [{ name: "m", provider: "compat", model: "x", reasoningEffort: "low" }],
      providers,
    );
    expect(reasoningEffortMetadata(config)).toEqual({ compat: { reasoningEffort: "low" } });
  });

  it("keys metadata by 'openai' for openai-responses", () => {
    const config = makeConfig(
      [{ name: "m", provider: "resp", model: "x", reasoningEffort: "medium" }],
      providers,
    );
    expect(reasoningEffortMetadata(config)).toEqual({ openai: { reasoningEffort: "medium" } });
  });

  it("returns undefined for anthropic and for models without the key", () => {
    const anthropic = makeConfig(
      [{ name: "m", provider: "claude", model: "x", reasoningEffort: "high" }],
      providers,
    );
    expect(reasoningEffortMetadata(anthropic)).toBeUndefined();
    const unset = makeConfig([{ name: "m", provider: "compat", model: "x" }], providers);
    expect(reasoningEffortMetadata(unset)).toBeUndefined();
  });
});

describe("streamChat providerMetadata", () => {
  function capturingModel(captured: { providerMetadata?: unknown }) {
    return new MockLanguageModelV1({
      doStream: async (options) => {
        captured.providerMetadata = options.providerMetadata;
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

  it("merges caller metadata with the openai strictSchemas/store defaults", async () => {
    const captured: { providerMetadata?: unknown } = {};
    const stream = streamChat({
      model: capturingModel(captured),
      messages: [{ role: "user", content: "hi" }],
      providerMetadata: { moonshot: { reasoningEffort: "high" } },
    });
    for await (const _ of stream) {
      // drain
    }
    expect(captured.providerMetadata).toEqual({
      moonshot: { reasoningEffort: "high" },
      openai: { strictSchemas: false, store: false },
    });
  });

  it("merges into the openai entry instead of replacing it", async () => {
    const captured: { providerMetadata?: unknown } = {};
    const stream = streamChat({
      model: capturingModel(captured),
      messages: [{ role: "user", content: "hi" }],
      providerMetadata: { openai: { reasoningEffort: "low" } },
    });
    for await (const _ of stream) {
      // drain
    }
    expect(captured.providerMetadata).toEqual({
      openai: { strictSchemas: false, store: false, reasoningEffort: "low" },
    });
  });
});
