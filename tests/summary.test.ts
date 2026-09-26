import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModelV1 } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import { summarizeMessages } from "../src/context/compaction";
import type { StreamEvent } from "../src/core/events";
import type { CoreMessage } from "../src/core/messages";
import { createDefaultRegistry } from "../src/tools";

const pad = (n: number) => "x".repeat(n);
const user = (text: string): CoreMessage => ({ role: "user", content: text });
const assistant = (text: string): CoreMessage => ({ role: "assistant", content: text });

function generateRound(text: string): LanguageModelV1["doGenerate"] {
  return async () => ({
    text,
    finishReason: "stop",
    usage: { promptTokens: 5, completionTokens: 3 },
    rawCall: { rawPrompt: null, rawSettings: {} },
  });
}

function textStream(text: string): LanguageModelV1["doStream"] {
  return async () => ({
    stream: convertArrayToReadableStream([
      { type: "text-delta", textDelta: text },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 3 },
      },
    ]),
    rawCall: { rawPrompt: null, rawSettings: {} },
  });
}

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
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

describe("summarizeMessages", () => {
  it("returns the model's text", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: generateRound("User wanted X; edited a.ts; TODO: tests"),
    });

    const summary = await summarizeMessages(
      [user("change a.ts"), assistant("done, edited a.ts")],
      model,
    );

    expect(summary).toBe("User wanted X; edited a.ts; TODO: tests");
  });

  it("sends the serialized transcript to the model", async () => {
    let seenPrompt = "";
    const model = new MockLanguageModelV1({
      doGenerate: async (options) => {
        seenPrompt = JSON.stringify(options.prompt);
        return generateRound("ok")(options);
      },
    });

    await summarizeMessages([user("hello there")], model);

    expect(seenPrompt).toContain("hello there");
  });

  it("propagates model errors", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });

    await expect(summarizeMessages([user("hi")], model)).rejects.toThrow("boom");
  });

  it("passes an abort signal to the model, with and without a caller signal", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const model = new MockLanguageModelV1({
      doGenerate: async (options) => {
        signals.push(options.abortSignal);
        return generateRound("ok")(options);
      },
    });

    await summarizeMessages([user("hi")], model, new AbortController().signal);
    await summarizeMessages([user("hi")], model);

    expect(signals[0]).toBeDefined();
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]).toBeDefined();
  });

  it("rejects promptly when the caller aborts the summary", async () => {
    const model = new MockLanguageModelV1({
      doGenerate: async (options) => {
        // Simulates a hung relay: only the abort signal resolves the call.
        // The abort may have landed before this listener is registered.
        await new Promise((_, reject) => {
          if (options.abortSignal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          options.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
        return generateRound("unreachable")(options);
      },
    });
    const controller = new AbortController();

    const promise = summarizeMessages([user("hi")], model, controller.signal);
    controller.abort();

    await expect(promise).rejects.toThrow();
  });
});

describe("AgentLoop compaction summary", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-summary-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(model: MockLanguageModelV1, configOverrides: Partial<StarConfig> = {}) {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig({ contextMaxTokens: 90, ...configOverrides }),
      cwd,
    });
  }

  async function loadLongHistory(loop: AgentLoop): Promise<void> {
    await loop.loadMessages([
      user(pad(400)),
      assistant(pad(400)),
      user("u2"),
      assistant("a2"),
      user("u3"),
      assistant("a3"),
    ]);
  }

  it("replaces the placeholder with a summary when compaction drops messages", async () => {
    const loop = makeLoop(
      new MockLanguageModelV1({
        doGenerate: generateRound("SUMMARY TEXT"),
        doStream: textStream("ok"),
      }),
    );
    await loadLongHistory(loop);

    await collect(loop.stream("hi", new AbortController().signal));

    const first = loop.getMessages()[0];
    expect(first?.role).toBe("user");
    expect(first?.content).toBe("[earlier conversation summarized]\nSUMMARY TEXT");
  });

  it("falls back to the truncation placeholder when the summary call throws", async () => {
    const loop = makeLoop(
      new MockLanguageModelV1({
        doGenerate: async () => {
          throw new Error("summary unavailable");
        },
        doStream: textStream("ok"),
      }),
    );
    await loadLongHistory(loop);

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events.some((e) => e.type === "text-delta" && e.text === "ok")).toBe(true);
    const first = loop.getMessages()[0];
    expect(first?.role).toBe("user");
    expect(first?.content).toBe("[context compacted: 2 earlier messages dropped]");
  });

  it("keeps the truncation placeholder in truncate mode without calling the model", async () => {
    let generateCalls = 0;
    const loop = makeLoop(
      new MockLanguageModelV1({
        doGenerate: async (options) => {
          generateCalls += 1;
          return generateRound("unused")(options);
        },
        doStream: textStream("ok"),
      }),
      { contextCompaction: "truncate" },
    );
    await loadLongHistory(loop);

    await collect(loop.stream("hi", new AbortController().signal));

    expect(generateCalls).toBe(0);
    expect(loop.getMessages()[0]?.content).toBe("[context compacted: 2 earlier messages dropped]");
  });
});
