import { tool } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createModel } from "../src/llm/provider";
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
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    permissions: { allow: [] },
    hooks: [],
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

describe("createModel", () => {
  it("builds a model for an openai-responses provider", () => {
    const model = createModel(
      makeConfig({
        providers: [
          {
            name: "p1",
            protocol: "openai-responses",
            baseURL: "https://relay.example.com/v1",
            apiKey: "test-key",
          },
        ],
      }),
    );
    expect(model.modelId).toBe("m-fast");
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

  it("maps reasoning stream parts to reasoning events", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "reasoning", textDelta: "pondering " },
          { type: "reasoning", textDelta: "deeply" },
          { type: "text-delta", textDelta: "Hi" },
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
      { type: "reasoning", text: "pondering " },
      { type: "reasoning", text: "deeply" },
      { type: "text-delta", text: "Hi" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 5, totalTokens: 8 },
      },
    ]);
  });

  it("sanitizes non-finite usage numbers to zero", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-delta", textDelta: "Hi" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: Number.NaN, completionTokens: Number.NaN },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events[1]).toEqual({
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
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

  it("ends via the idle watchdog when the source stays open after the finish chunk", async () => {
    // The AI SDK holds the finish part until the source stream closes, so a
    // relay that sends everything but keeps the socket open can only be
    // rescued by the watchdog.
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "Hi" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            });
            // deliberately never closes
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "hi" }],
        idleTimeoutMs: 50,
      }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "finish", finishReason: "idle-timeout", usage: undefined },
    ]);
  });

  it("ends the stream gracefully when no part arrives within the idle timeout", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "text-delta", textDelta: "partial" });
            // never emits finish and never closes
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "hi" }],
        idleTimeoutMs: 50,
      }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "partial" },
      { type: "finish", finishReason: "idle-timeout", usage: undefined },
    ]);
  });

  it("suppresses stream error parts caused by a user-initiated abort", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "error", error: new Error("This operation was aborted") },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "hi" }],
        abortSignal: controller.signal,
        idleTimeoutMs: 50,
      }),
    );

    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  it("waits for a slow first part beyond the mid-stream idle timeout", async () => {
    // Thinking models and slow relays can take far longer than the idle
    // window before producing anything; the first part gets its own budget.
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          async start(controller) {
            await new Promise((resolve) => setTimeout(resolve, 80));
            controller.enqueue({ type: "text-delta", textDelta: "late" });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            });
            controller.close();
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "hi" }],
        idleTimeoutMs: 30,
        firstPartTimeoutMs: 500,
      }),
    );

    expect(events).toEqual([
      { type: "text-delta", text: "late" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
    ]);
  });

  it("ends gracefully when the first part never arrives", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: new ReadableStream({
          start() {
            // never enqueues and never closes
          },
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({
        model,
        messages: [{ role: "user", content: "hi" }],
        idleTimeoutMs: 10_000,
        firstPartTimeoutMs: 50,
      }),
    );

    expect(events).toEqual([{ type: "finish", finishReason: "idle-timeout", usage: undefined }]);
  });
});
