import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

// The loop wraps streamChat; mock it to deliver a watchdog-truncated finish
// without timing out a real stream.
vi.mock("../src/llm/stream", () => ({
  streamChat: async function* (): AsyncGenerator<StreamEvent> {
    yield { type: "text-delta", text: "partial reply" };
    yield { type: "finish", finishReason: "idle-timeout", truncated: true };
  },
}));

const { AgentLoop } = await import("../src/agent/loop");

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
    gitSnapshots: false,
    ...overrides,
  };
}

describe("idle-truncated finish notice", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-truncated-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("emits a notice when the finish event is marked truncated", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("hi", new AbortController().signal)) {
      events.push(event);
    }

    const notice = events.find((e) => e.type === "notice");
    expect(notice).toBeDefined();
    if (notice?.type === "notice") {
      expect(notice.message).toContain("cut short by the stream idle timeout");
    }
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toMatchObject({ finishReason: "idle-timeout", truncated: true });
  });
});
