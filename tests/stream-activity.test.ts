import { MockLanguageModelV1 } from "ai/test";
import { describe, expect, it } from "vitest";
import { registerStreamActivity, streamActivity, wrapFetchWithActivity } from "../src/llm/activity";
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
});

