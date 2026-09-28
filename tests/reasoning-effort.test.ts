import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { setReasoningEffortInToml } from "../src/config/save";
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

  it("accepts provider-specific level names and rejects empty strings", () => {
    // Level naming is not standardized (minimal/max/xhigh/none...), so any
    // non-empty string passes and the server validates it.
    const config = makeConfig([{ name: "m", provider: "p", model: "x", reasoningEffort: "xhigh" }]);
    expect(config.models[0]?.reasoningEffort).toBe("xhigh");
    expect(() =>
      makeConfig([{ name: "m", provider: "p", model: "x", reasoningEffort: "" }]),
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

describe("setReasoningEffortInToml", () => {
  const base = [
    'defaultModel = "a"',
    "",
    "[[models]]",
    'name = "a"',
    'provider = "p1"',
    'model = "a-1"',
    "",
    "[[models]]",
    'name = "b"',
    'provider = "p2"',
    'model = "b-1"',
    'reasoningEffort = "low" # keep this comment',
    "",
  ].join("\n");

  it("inserts the key after the model line of the matching block", () => {
    const next = setReasoningEffortInToml(base, "a", "high");
    expect(next).toContain('model = "a-1"\nreasoningEffort = "high"');
    // the other block is untouched
    expect(next).toContain('reasoningEffort = "low" # keep this comment');
    expect(next).toContain('model = "b-1"');
  });

  it("replaces an existing key in place, keeping the trailing comment", () => {
    const next = setReasoningEffortInToml(base, "b", "max");
    expect(next).toContain('reasoningEffort = "max" # keep this comment');
    expect(next).not.toContain('reasoningEffort = "low"');
  });

  it("removes the key when effort is undefined", () => {
    const next = setReasoningEffortInToml(base, "b", undefined);
    expect(next).not.toContain("reasoningEffort");
    expect(next).toContain('model = "b-1"');
  });

  it("matches single-quoted names and ignores name keys elsewhere", () => {
    const content =
      '[other]\nname = "a"\n\n[[models]]\nname = \'a\'\nprovider = "p"\nmodel = "x"\n';
    const next = setReasoningEffortInToml(content, "a", "low");
    expect(next).toContain('model = "x"\nreasoningEffort = "low"');
    expect(next).toContain('[other]\nname = "a"');
  });

  it("returns null when no block declares the model", () => {
    expect(setReasoningEffortInToml(base, "missing", "high")).toBeNull();
    expect(setReasoningEffortInToml("", "a", "high")).toBeNull();
  });

  it("is a no-op when removing an unset key", () => {
    expect(setReasoningEffortInToml(base, "a", undefined)).toBe(base);
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
