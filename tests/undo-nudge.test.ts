import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentTasks } from "../src/agent/agent-tasks";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { clearSnapshots } from "../src/tools/fs/snapshots";
import { rmWithRetry } from "./test-fs";

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "m",
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
    gitSnapshots: false,
    webFetchAllowPrivateHosts: false,
    ...overrides,
  };
}

type Chunk =
  | { type: "text-delta"; textDelta: string }
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

function mockModel(rounds: Chunk[][]): MockLanguageModelV1 {
  let call = 0;
  return new MockLanguageModelV1({
    doStream: async () => {
      const chunks = rounds[Math.min(call, rounds.length - 1)] ?? [];
      call++;
      return {
        stream: convertArrayToReadableStream(chunks),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("undo after loop-injected user messages", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-nudge-undo-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-nudge-undo-home-"));
    vi.stubEnv("STAR_HOME", home);
    clearSnapshots();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    defaultAgentTasks.cleanup();
    clearSnapshots();
    await rmWithRetry(cwd);
    await rmWithRetry(home);
  });

  it("one /undo retracts a turn that took an auto-continue nudge, files included", async () => {
    const loop = new AgentLoop({
      model: mockModel([
        textRound("I will write the file now."),
        toolCallRound("c1", "write_file", { path: "f.txt", content: "from-the-turn" }),
        textRound("done"),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });

    await collect(loop.stream("write f.txt", new AbortController().signal));
    expect(fs.readFileSync(path.join(cwd, "f.txt"), "utf8")).toBe("from-the-turn");
    // The turn really did take a nudge.
    expect(
      loop
        .getMessages()
        .some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("[auto-continue]"),
        ),
    ).toBe(true);
    const length = loop.getMessages().length;

    const undo = await loop.undoLastTurn();

    // The whole real turn goes in one retraction — the nudge is not a turn
    // boundary — and the verified marker lets the file snapshot roll back.
    expect(undo.removed).toBe(length);
    expect(loop.getMessages()).toHaveLength(0);
    expect(fs.existsSync(path.join(cwd, "f.txt"))).toBe(false);
  });

  it("one /undo retracts a turn that received a background subagent report", async () => {
    defaultAgentTasks.start(() => Promise.resolve("child report: all done"), {
      prompt: "side quest",
      description: "side quest",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const loop = new AgentLoop({
      model: mockModel([
        toolCallRound("c1", "write_file", { path: "g.txt", content: "from-the-turn" }),
        textRound("done"),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });

    await collect(loop.stream("write g.txt", new AbortController().signal));
    expect(
      loop
        .getMessages()
        .some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("[background subagent"),
        ),
    ).toBe(true);
    const length = loop.getMessages().length;

    const undo = await loop.undoLastTurn();

    expect(undo.removed).toBe(length);
    expect(loop.getMessages()).toHaveLength(0);
    expect(fs.existsSync(path.join(cwd, "g.txt"))).toBe(false);
  });

  it("persists the synthetic marker and keeps the one-shot undo across a resume", async () => {
    const store = await SessionStore.create(cwd, "m");
    const loop = new AgentLoop({
      model: mockModel([
        textRound("I will write the file now."),
        toolCallRound("c1", "write_file", { path: "h.txt", content: "from-the-turn" }),
        textRound("done"),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    await collect(loop.stream("write h.txt", new AbortController().signal));

    // The meta rides a __starMeta key on the jsonl row; the CoreMessage view
    // the model would see stays clean.
    const raw = fs.readFileSync(path.join(store.dir, "messages.jsonl"), "utf8");
    expect(raw).toContain("__starMeta");
    const core = await store.messages();
    expect(core.every((m) => !("__starMeta" in m))).toBe(true);
    const starred = await store.starMessages();
    const nudge = starred.find((star) => star.meta?.synthetic === "nudge");
    expect(nudge).toBeDefined();
    expect(
      typeof nudge?.message.content === "string" &&
        nudge.message.content.includes("[auto-continue]"),
    ).toBe(true);
    // Older rows and plain messages carry no meta.
    expect(
      starred.find((star) => star.message.role === "user" && star.meta === undefined),
    ).toBeDefined();

    // A resume reloads through the star view: the nudge still is not a turn
    // boundary, so one retraction drops the whole turn even without markers.
    const loop2 = new AgentLoop({
      model: mockModel([textRound("unused")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });
    await loop2.loadMessages(await store.starMessages());
    const before = loop2.getMessages().length;
    const retracted = await loop2.retractLastTurn();
    expect(retracted.removed).toBe(before);
    expect(loop2.getMessages()).toHaveLength(0);
  });
});
