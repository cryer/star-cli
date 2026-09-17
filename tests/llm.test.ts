import { tool } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { listModels, resolveModelConfig } from "../src/llm/registry";
import { streamChat } from "../src/llm/stream";

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "fast",
    permissionMode: "ask",
    providers: [],
    models: [
      { name: "fast", provider: "p1", model: "m-fast" },
      { name: "smart", provider: "p1", model: "m-smart" },
    ],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("resolveModelConfig", () => {
  it("uses defaultModel when modelName is omitted", () => {
    const model = resolveModelConfig(makeConfig());
    expect(model.name).toBe("fast");
    expect(model.model).toBe("m-fast");
  });

  it("resolves an explicit model name", () => {
    const model = resolveModelConfig(makeConfig(), "smart");
    expect(model.name).toBe("smart");
  });

  it("throws with available model names when not found", () => {
    expect(() => resolveModelConfig(makeConfig(), "nope")).toThrowError(
      /Model "nope" not found\. Available models: fast, smart/,
    );
  });

  it("listModels returns all configured models", () => {
    expect(listModels(makeConfig()).map((m) => m.name)).toEqual(["fast", "smart"]);
  });
});

describe("streamChat", () => {
  it("normalizes text-delta and finish events with usage", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-delta", textDelta: "Hello" },
          { type: "text-delta", textDelta: " world" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 3, completionTokens: 5 },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "Hello" },
      { type: "text-delta", text: " world" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      },
    ]);
  });

  it("normalizes tool-call events", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            type: "tool-call",
            toolCallType: "function",
            toolCallId: "call-1",
            toolName: "echo",
            args: JSON.stringify({ text: "hi" }),
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { promptTokens: 2, completionTokens: 4 },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "echo hi" }],
        tools: {
          echo: tool({
            description: "Echo text",
            parameters: z.object({ text: z.string() }),
          }),
        },
      }),
    );

    expect(events[0]).toEqual({
      type: "tool-call",
      id: "call-1",
      name: "echo",
      args: { text: "hi" },
    });
    expect(events[1]?.type).toBe("finish");
  });

  it("normalizes error events into Error instances", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([{ type: "error", error: new Error("boom") }]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events[0]?.type).toBe("error");
    if (events[0]?.type === "error") {
      expect(events[0].error).toBeInstanceOf(Error);
      expect(events[0].error.message).toBe("boom");
    }
  });
});
