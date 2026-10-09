import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { coreMessageText } from "../src/core/messages";
import { createDefaultRegistry } from "../src/tools";
import { rmWithRetry } from "./test-fs";

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "error"; error: unknown }
  | {
      type: "tool-call";
      toolCallType: "function";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      type: "finish";
      finishReason: "stop" | "tool-calls";
      usage: { promptTokens: number; completionTokens: number };
    };

function textRound(text: string): Chunk[] {
  return [
    { type: "text-delta", textDelta: text },
    { type: "finish", finishReason: "stop", usage: { promptTokens: 5, completionTokens: 3 } },
  ];
}

function toolCallRound(id: string, name: string, args: unknown): Chunk[] {
  return [
    {
      type: "tool-call",
      toolCallType: "function",
      toolCallId: id,
      toolName: name,
      args: JSON.stringify(args),
    },
    {
      type: "finish",
      finishReason: "tool-calls",
      usage: { promptTokens: 5, completionTokens: 3 },
    },
  ];
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
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: true,
    webFetchAllowPrivateHosts: false,
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

describe("AgentLoop steering (injectUserMessage)", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-steer-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-steer-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rmWithRetry(cwd);
    await rmWithRetry(home);
  });

  const STEER = "please also update the readme";

  // A model whose first stream injects a steer mid-turn (simulating the user
  // submitting while the reply streams), and captures every request prompt.
  function steeringModel(rounds: Chunk[][]) {
    const prompts: unknown[] = [];
    let loop: AgentLoop | null = null;
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        const index = call++;
        prompts.push(options.prompt);
        if (index === 0) loop?.injectUserMessage(STEER);
        return {
          stream: convertArrayToReadableStream(rounds[Math.min(index, rounds.length - 1)] ?? []),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    return {
      model,
      prompts,
      callCount: () => call,
      bind: (l: AgentLoop) => {
        loop = l;
      },
    };
  }

  function makeLoop(model: MockLanguageModelV1): AgentLoop {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      retryDelayMs: 1,
    });
  }

  it("delivers an injected steer at the next step boundary, after the tool batch", async () => {
    const rig = steeringModel([
      toolCallRound("call-1", "todo_read", {}),
      textRound("Adjusted, done."),
    ]);
    const loop = makeLoop(rig.model);
    rig.bind(loop);

    const events = await collect(loop.stream("do the task", new AbortController().signal));

    expect(rig.callCount()).toBe(2);
    // The first request predates the steer; the second carries it.
    expect(JSON.stringify(rig.prompts[0])).not.toContain(STEER);
    expect(JSON.stringify(rig.prompts[1])).toContain(STEER);
    expect(events.some((e) => e.type === "notice" && e.message.includes("steering"))).toBe(true);

    const stars = loop.getStarMessages();
    const steerIndex = stars.findIndex(
      (s) => s.meta?.synthetic === "steer" && coreMessageText(s.message) === STEER,
    );
    expect(steerIndex).toBeGreaterThan(-1);
    // Delivered after the tool result of the in-flight step, not before it.
    const toolIndex = stars.findIndex((s) => s.message.role === "tool");
    expect(toolIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeGreaterThan(toolIndex);
  });

  it("keeps a text-only turn alive when a steer is queued", async () => {
    const rig = steeringModel([textRound("All done."), textRound("Steered reply.")]);
    const loop = makeLoop(rig.model);
    rig.bind(loop);

    const events = await collect(loop.stream("do the task", new AbortController().signal));

    // Without the steer the text-only reply would have ended the turn.
    expect(rig.callCount()).toBe(2);
    expect(JSON.stringify(rig.prompts[1])).toContain(STEER);
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("the turn continues")),
    ).toBe(true);
    expect(loop.getStarMessages().some((s) => s.meta?.synthetic === "steer")).toBe(true);
    // Delivered steers are consumed.
    expect(loop.takeUndeliveredSteers()).toEqual([]);
  });

  it("hands back steers that never reached a step boundary (turn errored first)", async () => {
    let loop: AgentLoop | null = null;
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        if (call++ === 0) loop?.injectUserMessage(STEER);
        const error = new Error("Incorrect API key");
        error.name = "AI_APICallError";
        (error as unknown as { statusCode: number }).statusCode = 401;
        return {
          stream: convertArrayToReadableStream([{ type: "error", error } satisfies Chunk]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    loop = makeLoop(model);

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events[events.length - 1]?.type).toBe("error");
    expect(loop.takeUndeliveredSteers()).toEqual([STEER]);
    expect(loop.takeUndeliveredSteers()).toEqual([]);
  });

  it("ignores blank steering text", () => {
    const loop = makeLoop(new MockLanguageModelV1());
    loop.injectUserMessage("   ");
    expect(loop.takeUndeliveredSteers()).toEqual([]);
  });
});
