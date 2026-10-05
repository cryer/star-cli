import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/schema";
import { registerStreamActivity, streamActivity, wrapFetchWithActivity } from "../src/llm/activity";
import { resolveModelConfig } from "../src/llm/registry";
import { streamChat } from "../src/llm/stream";

describe("wrapFetchWithActivity", () => {
  it("registers a tracker keyed by the request signal and timestamps chunks", async () => {
    const controller = new AbortController();
    const encode = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(encode.encode("data: one\n\n"));
        await new Promise((resolve) => setTimeout(resolve, 30));
        c.enqueue(encode.encode("data: two\n\n"));
        c.close();
      },
    });
    const wrapped = wrapFetchWithActivity(async () => new Response(body));

    const before = Date.now();
    const response = await wrapped("https://relay.test/v1/responses", {
      signal: controller.signal,
    });
    const tracker = streamActivity(controller.signal);
    expect(tracker).toBeDefined();
    expect(tracker?.lastChunkAt).toBeGreaterThanOrEqual(before);

    const text = await response.text();
    expect(text).toBe("data: one\n\ndata: two\n\n");
    // The second chunk landed ~30ms in, so the timestamp must have advanced
    // past the initial headers timestamp.
    expect(tracker?.lastChunkAt).toBeGreaterThanOrEqual(before + 20);
  });

  it("leaves requests without a signal or body untracked", async () => {
    const wrapped = wrapFetchWithActivity(async () => new Response("ok"));
    const response = await wrapped("https://relay.test/v1/models");
    expect(await response.text()).toBe("ok");
  });
});

describe("streamChat byte-level keepalive", () => {
  it("extends the watchdog while raw bytes flow, cuts once they stop", async () => {
    let tracker: { lastChunkAt: number } | undefined;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        // The SDK forwards streamChat's internal abort signal to doStream;
        // production trackers are registered by wrapFetchWithActivity.
        if (options.abortSignal) tracker = registerStreamActivity(options.abortSignal);
        return {
          stream: new ReadableStream({
            start(c) {
              c.enqueue({ type: "text-delta", textDelta: "partial" });
              // Then the stream hangs — the "relay buffering" scenario.
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    const started = Date.now();
    const gen = streamChat({
      model,
      messages: [{ role: "user", content: "hi" }],
      idleTimeoutMs: 60,
      firstPartTimeoutMs: 500,
    });
    // Heartbeat: as long as bytes keep arriving the watchdog must not cut.
    const heartbeat = setInterval(() => {
      if (tracker) tracker.lastChunkAt = Date.now();
    }, 20);
    setTimeout(() => clearInterval(heartbeat), 220);

    const events = [];
    for await (const event of gen) events.push(event);

    const elapsed = Date.now() - started;
    // Without keepalives the cut would have fired at ~60ms; heartbeats held
    // it off until they stopped at ~220ms.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(events[0]).toEqual({ type: "text-delta", text: "partial" });
    const finish = events[events.length - 1];
    expect(finish).toMatchObject({ type: "finish", finishReason: "idle-timeout", truncated: true });
  });

  it("loses no part when parts arrive after keepalive-extended watchdog wake-ups", async () => {
    // Every gap below is wider than the idle timeout, so each one drives the
    // watchdog through keepalive cycles. The consume loop must reuse the same
    // pending read across those cycles: fullStream queues one reader.read()
    // per next() call, so a next() abandoned at a wake-up would silently
    // consume the part that arrives during the next gap.
    let tracker: { lastChunkAt: number } | undefined;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        if (options.abortSignal) tracker = registerStreamActivity(options.abortSignal);
        return {
          stream: new ReadableStream({
            async start(c) {
              c.enqueue({ type: "text-delta", textDelta: "one" });
              await new Promise((resolve) => setTimeout(resolve, 200));
              c.enqueue({ type: "text-delta", textDelta: "two" });
              await new Promise((resolve) => setTimeout(resolve, 200));
              c.enqueue({ type: "text-delta", textDelta: "three" });
              c.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { promptTokens: 5, completionTokens: 3 },
              });
              c.close();
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });

    const gen = streamChat({
      model,
      messages: [{ role: "user", content: "hi" }],
      idleTimeoutMs: 80,
      firstPartTimeoutMs: 500,
    });
    // Bytes keep flowing (the SDK-swallowed heartbeat), so the watchdog must
    // extend across the gaps instead of cutting the stream.
    const heartbeat = setInterval(() => {
      if (tracker) tracker.lastChunkAt = Date.now();
    }, 20);

    const events = [];
    for await (const event of gen) events.push(event);
    clearInterval(heartbeat);

    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "text-delta", "finish"]);
    expect(events.slice(0, 3).map((e) => e.type === "text-delta" && e.text)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect(events[3]).toMatchObject({ type: "finish", finishReason: "stop" });
  });
});

describe("per-model stream timeout config", () => {
  it("parses per-model watchdog overrides and resolves them", () => {
    const config = ConfigSchema.parse({
      defaultModel: "m",
      providers: [],
      models: [
        { name: "m", provider: "p", model: "x", streamIdleTimeoutSec: 90 },
        { name: "plain", provider: "p", model: "y" },
      ],
    });
    expect(resolveModelConfig(config, "m").streamIdleTimeoutSec).toBe(90);
    expect(resolveModelConfig(config, "plain").streamIdleTimeoutSec).toBeUndefined();
    expect(resolveModelConfig(config, "plain").streamFirstChunkTimeoutSec).toBeUndefined();
  });

  it("rejects non-positive per-model timeouts", () => {
    expect(() =>
      ConfigSchema.parse({
        defaultModel: "m",
        providers: [],
        models: [{ name: "m", provider: "p", model: "x", streamFirstChunkTimeoutSec: 0 }],
      }),
    ).toThrow();
  });
});
