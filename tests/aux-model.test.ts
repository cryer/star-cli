import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "main",
    permissionMode: "auto",
    providers: [
      {
        name: "p",
        protocol: "anthropic",
        baseURL: "https://example.invalid",
        apiKey: "test-key",
      },
    ],
    models: [
      { name: "main", provider: "p", model: "main-model" },
      { name: "small", provider: "p", model: "small-model", temperature: 0.7 },
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
    gitSnapshots: false,
    ...overrides,
  };
}

function textModel(text: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-delta", textDelta: text },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 3 },
        },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe("auxiliary (small) model resolution", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-aux-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(config: StarConfig, model = textModel("done")): AgentLoop {
    return new AgentLoop({ model, registry: createDefaultRegistry(), config, cwd });
  }

  it("falls back to the main model when smallModel is unset", () => {
    const model = textModel("x");
    const loop = makeLoop(makeConfig(), model);
    expect(loop.getAuxModel()).toBe(model);
    expect(loop.getAuxTemperature()).toBeUndefined();
  });

  it("resolves config.smallModel for auxiliary calls", () => {
    const main = textModel("x");
    const loop = makeLoop(makeConfig({ smallModel: "small" }), main);
    const aux = loop.getAuxModel();
    expect(aux).not.toBe(main);
    expect(aux.provider).toContain("anthropic");
    expect(loop.getAuxTemperature()).toBe(0.7);
  });

  it("degrades to the main model with a one-time notice on a bad smallModel", async () => {
    const main = textModel("done");
    const loop = makeLoop(makeConfig({ smallModel: "does-not-exist" }), main);
    expect(loop.getAuxModel()).toBe(main);

    const events = await collect(loop.stream("hi", new AbortController().signal));
    const notices = events.filter((e) => e.type === "notice").map((e) => e.message);
    expect(notices.some((m) => m.includes('smallModel "does-not-exist"'))).toBe(true);

    const more = await collect(loop.stream("again", new AbortController().signal));
    const repeated = more.filter((e) => e.type === "notice").map((e) => e.message);
    expect(repeated.some((m) => m.includes("smallModel"))).toBe(false);
  });
});
