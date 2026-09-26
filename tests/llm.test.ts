import { tool } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { describe, expect, it, vi } from "vitest";
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
    streamFirstChunkTimeoutSec: 300,
    streamMaxRetries: 3,
    maxAutoContinues: 2,
    notifyBell: true,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: true,
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

  it("asks openai-compatible relays for a terminal usage chunk", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", async (_input: unknown, init?: { body?: unknown }) => {
      sentBody = typeof init?.body === "string" ? init.body : "";
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    try {
      const model = createModel(
        makeConfig({
          providers: [
            {
              name: "p1",
              protocol: "openai-compatible",
              baseURL: "https://relay.example.com/v1",
              apiKey: "test-key",
            },
          ],
        }),
      );
      await model.doStream({
        inputFormat: "prompt",
        mode: { type: "regular" },
        prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      });
      expect(JSON.parse(sentBody).stream_options).toEqual({ include_usage: true });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("extracts OpenAI-style cachedPromptTokens from providerMetadata", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 100, completionTokens: 10 },
            providerMetadata: { openai: { cachedPromptTokens: 40 } },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          cachedPromptTokens: 40,
        },
      },
    ]);
  });

  it("extracts Anthropic-style cacheReadInputTokens from providerMetadata", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 50, completionTokens: 10 },
            providerMetadata: {
              anthropic: { cacheReadInputTokens: 30, cacheCreationInputTokens: 12 },
            },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          promptTokens: 50,
          completionTokens: 10,
          totalTokens: 60,
          cacheReadInputTokens: 30,
        },
      },
    ]);
  });

  it("ignores missing or non-numeric cache fields in providerMetadata", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 7, completionTokens: 3 },
            providerMetadata: {
              openai: { cachedPromptTokens: "40", reasoningTokens: 5 },
              custom: { note: "no cache fields here" },
            },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });

    const events = await collect(
      streamChat({ model, messages: [{ role: "user", content: "hi" }] }),
    );

    expect(events).toEqual([
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
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
      { type: "finish", finishReason: "idle-timeout", usage: undefined, truncated: true },
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
      { type: "finish", finishReason: "idle-timeout", usage: undefined, truncated: true },
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

  it("clears the idle timer when the stream throws", async () => {
    vi.useFakeTimers();
    try {
      const model = new MockLanguageModelV1({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "Hi" });
              controller.error(new Error("source exploded"));
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });

      await expect(
        collect(streamChat({ model, messages: [{ role: "user", content: "hi" }] })),
      ).rejects.toThrow("source exploded");
      // Without the finally cleanup the watchdog timer would stay pending.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
