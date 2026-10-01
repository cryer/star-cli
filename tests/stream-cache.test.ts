import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import type { CoreMessage } from "../src/core/messages";
import { withAnthropicCacheBreakpoints } from "../src/llm/stream";

function messages(): CoreMessage[] {
  return [
    { role: "system", content: "SYSTEM" },
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: "last" },
  ];
}

function cacheControlOf(message: CoreMessage | undefined): unknown {
  return message?.experimental_providerMetadata?.anthropic?.cacheControl;
}

describe("withAnthropicCacheBreakpoints", () => {
  it("marks the system message and the last message for anthropic models", () => {
    const model = new MockLanguageModelV1({ provider: "anthropic.messages" });
    const input = messages();
    const result = withAnthropicCacheBreakpoints(model, input);

    expect(cacheControlOf(result[0])).toEqual({ type: "ephemeral" });
    expect(cacheControlOf(result[1])).toBeUndefined();
    expect(cacheControlOf(result[2])).toBeUndefined();
    expect(cacheControlOf(result[3])).toEqual({ type: "ephemeral" });
    // History stays untouched: breakpoints ride on request-time copies.
    expect(input[0]?.experimental_providerMetadata).toBeUndefined();
    expect(input[3]?.experimental_providerMetadata).toBeUndefined();
  });

  it("returns the array unchanged for non-anthropic models", () => {
    const model = new MockLanguageModelV1({ provider: "openai.chat" });
    const input = messages();
    expect(withAnthropicCacheBreakpoints(model, input)).toBe(input);
  });

  it("marks only the last message when there is no system head", () => {
    const model = new MockLanguageModelV1({ provider: "anthropic.messages" });
    const input = messages().slice(1);
    const result = withAnthropicCacheBreakpoints(model, input);
    expect(cacheControlOf(result[0])).toBeUndefined();
    expect(cacheControlOf(result[result.length - 1])).toEqual({ type: "ephemeral" });
  });

  it("merges with existing provider metadata instead of replacing it", () => {
    const model = new MockLanguageModelV1({ provider: "anthropic.messages" });
    const input: CoreMessage[] = [
      {
        role: "system",
        content: "SYSTEM",
        experimental_providerMetadata: { anthropic: { other: 1 } },
      },
      { role: "user", content: "hi" },
    ];
    const result = withAnthropicCacheBreakpoints(model, input);
    expect(result[0]?.experimental_providerMetadata?.anthropic).toEqual({
      other: 1,
      cacheControl: { type: "ephemeral" },
    });
  });
});
