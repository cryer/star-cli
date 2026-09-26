import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { type CoreMessage, retractLastTurn } from "../src/core/messages";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { clearSnapshots, undoTurnSnapshots } from "../src/tools/fs/snapshots";

function makeConfig(): StarConfig {
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
    permissions: { allow: [], deny: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: true,
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

describe("retractLastTurn", () => {
  it("drops the last user message and everything after it", () => {
    const messages: CoreMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "text", text: "reply one" }] },
      { role: "user", content: "second" },
      { role: "assistant", content: [{ type: "text", text: "reply two" }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "bash", result: "ok" }],
      },
    ];
    const result = retractLastTurn(messages);
    expect(result.removed).toBe(3);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "reply one" }],
    });
  });

  it("retracts again after a previous retraction", () => {
    const once = retractLastTurn([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
      { role: "assistant", content: "d" },
    ]);
    const twice = retractLastTurn(once.messages);
    expect(twice.removed).toBe(2);
    expect(twice.messages).toHaveLength(0);
  });

  it("keeps a leading system message and reports zero when there is no user turn", () => {
    const onlySystem: CoreMessage[] = [{ role: "system", content: "sys" }];
    expect(retractLastTurn(onlySystem)).toEqual({ messages: onlySystem, removed: 0 });
    expect(retractLastTurn([])).toEqual({ messages: [], removed: 0 });
  });

  it("retracts a dangling user message with no reply yet", () => {
    const result = retractLastTurn([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "unanswered" },
    ]);
    expect(result.removed).toBe(1);
    expect(result.messages).toHaveLength(2);
  });
});

describe("AgentLoop.retractLastTurn", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-retract-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("trims history and persists it to the session store", async () => {
    const store = await SessionStore.create("/tmp/work", "m");
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd: "/tmp/work",
      sessionStore: store,
    });
    await loop.loadMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ]);
    await store.replaceMessages([...loop.getMessages()]);

    // History loaded wholesale carries no turn marker, so no file snapshots
    // may be reverted for it.
    expect(await loop.retractLastTurn()).toEqual({ removed: 2, turn: undefined });
    expect(loop.getMessages().map((m) => m.role)).toEqual(["system", "user", "assistant"]);

    const persisted = await store.messages();
    expect(persisted.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("returns 0 when there is nothing to retract", async () => {
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd: "/tmp/work",
      sessionStore: null,
    });
    expect(await loop.retractLastTurn()).toEqual({ removed: 0 });
  });
});

describe("AgentLoop.previewLastTurnRetraction", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-undo-preview-"));
    clearSnapshots();
  });

  afterEach(() => {
    clearSnapshots();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("matches retractLastTurn without mutating messages or turn markers", async () => {
    const loop = new AgentLoop({
      model: mockModel([textRound("one"), textRound("two")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });
    await collect(loop.stream("first", new AbortController().signal));
    await collect(loop.stream("second", new AbortController().signal));
    const before = loop.getMessages();

    const preview = loop.previewLastTurnRetraction();

    expect(preview.removed).toBe(2);
    expect(preview.turn).toBeDefined();
    // Read-only: messages unchanged, and a repeated preview is identical.
    expect(loop.getMessages()).toEqual(before);
    expect(loop.previewLastTurnRetraction()).toEqual(preview);
    // The real retraction agrees with the preview.
    expect(await loop.retractLastTurn()).toEqual(preview);
  });

  it("reports no verified turn for wholesale-loaded history", async () => {
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });
    await loop.loadMessages([
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ]);
    expect(loop.previewLastTurnRetraction()).toEqual({ removed: 2, turn: undefined });
    expect(loop.getMessages()).toHaveLength(2);
  });

  it("returns removed: 0 when there is nothing to retract", () => {
    const loop = new AgentLoop({
      model: null as never,
      registry: null as never,
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });
    expect(loop.previewLastTurnRetraction()).toEqual({ removed: 0 });
  });
});

describe("turn-scoped undo (end to end)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-turn-undo-"));
    clearSnapshots();
  });

  afterEach(() => {
    clearSnapshots();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("reverts only the retracted turn's file changes", async () => {
    const loop = new AgentLoop({
      model: mockModel([
        toolCallRound("c1", "write_file", { path: "f.txt", content: "from-turn-1" }),
        textRound("wrote it"),
        textRound("just chatting"),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: null,
    });

    await collect(loop.stream("write f.txt", new AbortController().signal));
    expect(fs.readFileSync(path.join(cwd, "f.txt"), "utf8")).toBe("from-turn-1");

    await collect(loop.stream("chat", new AbortController().signal));

    // Undo the pure-chat turn: messages retracted, turn-1 file untouched.
    const undoChat = await loop.retractLastTurn();
    expect(undoChat.removed).toBe(2);
    expect(undoChat.turn).toBeDefined();
    expect(await undoTurnSnapshots(undoChat.turn as number)).toEqual([]);
    expect(fs.readFileSync(path.join(cwd, "f.txt"), "utf8")).toBe("from-turn-1");

    // Undo the writing turn: its file change goes away with the messages.
    const undoWrite = await loop.retractLastTurn();
    expect(undoWrite.turn).toBeDefined();
    const reverted = await undoTurnSnapshots(undoWrite.turn as number);
    expect(reverted.some((m) => m.includes("f.txt"))).toBe(true);
    expect(fs.existsSync(path.join(cwd, "f.txt"))).toBe(false);
    expect(loop.getMessages()).toHaveLength(0);
  });
});
