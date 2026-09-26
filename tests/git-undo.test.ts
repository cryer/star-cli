import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { clearSnapshots, setSnapshotHooks, snapshotCount } from "../src/tools/fs/snapshots";

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

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "star-gitundo-home-"));
  dir = mkdtempSync(path.join(os.tmpdir(), "star-gitundo-"));
  vi.stubEnv("STAR_HOME", home);
  clearSnapshots();
});

afterEach(() => {
  setSnapshotHooks(null);
  clearSnapshots();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// A turn that changes files twice: x.txt through write_file (snapshotted) and
// bash-made.txt through bash (the blind spot per-file snapshots cannot see).
async function runChangeTurn(loop: AgentLoop): Promise<void> {
  await collect(loop.stream("change files in the project", new AbortController().signal));
}

function makeChangeLoop(config: StarConfig, store?: SessionStore): AgentLoop {
  return new AgentLoop({
    model: mockModel([
      toolCallRound("c1", "write_file", { path: "x.txt", content: "after" }),
      toolCallRound("c2", "bash", { command: "echo made > bash-made.txt" }),
      textRound("done"),
    ]),
    registry: createDefaultRegistry(),
    config,
    cwd: dir,
    sessionStore: store ?? null,
  });
}

describe("git-snapshot /undo", () => {
  it("restores bash-made changes too and discards the turn's per-file snapshots", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const store = await SessionStore.create(dir, "test-model");
    const loop = makeChangeLoop(makeConfig(), store);

    await runChangeTurn(loop);
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("after");
    expect(existsSync(path.join(dir, "bash-made.txt"))).toBe(true);
    expect(snapshotCount()).toBe(1);

    const preview = loop.previewLastTurnRetraction();
    expect(preview.removed).toBeGreaterThan(0);
    expect(preview.turn).toBeDefined();
    expect(preview.tree).toBeDefined();

    const outcome = await loop.undoLastTurn();

    expect(outcome.tree).toBeDefined();
    expect(outcome.reverted[0]).toContain("git snapshot");
    // write_file's change reverted — through the tree, not the snapshot
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("before");
    // bash's change reverted too: the old blind spot is gone
    expect(existsSync(path.join(dir, "bash-made.txt"))).toBe(false);
    // per-file snapshot discarded (not double-restored), checkpoint removed
    expect(snapshotCount()).toBe(0);
    expect(await store.listCheckpoints()).toHaveLength(0);
    // the conversation turn was retracted
    expect(loop.getMessages()).toHaveLength(0);
    // and the pre-undo state is redoable
    expect(loop.peekRedo()).not.toBeNull();
    expect(loop.peekRedo()?.label).toContain("change files");
  });

  it("keeps the per-file snapshot path when git snapshots are disabled", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const loop = makeChangeLoop(makeConfig({ gitSnapshots: false }));

    await runChangeTurn(loop);
    expect(snapshotCount()).toBe(1);
    expect(loop.previewLastTurnRetraction().tree).toBeUndefined();

    const outcome = await loop.undoLastTurn();

    expect(outcome.tree).toBeUndefined();
    expect(outcome.reverted.join("\n")).toContain("x.txt");
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("before");
    // bash-made changes stay beyond reach on this path, as before the feature
    expect(existsSync(path.join(dir, "bash-made.txt"))).toBe(true);
    expect(snapshotCount()).toBe(0);
    expect(loop.peekRedo()).toBeNull();
  });

  it("returns removed 0 when there is nothing to undo", async () => {
    const loop = makeChangeLoop(makeConfig());
    const outcome = await loop.undoLastTurn();
    expect(outcome.removed).toBe(0);
    expect(outcome.reverted).toEqual([]);
    expect(loop.peekRedo()).toBeNull();
  });
});

describe("/redo", () => {
  it("restores the exact pre-undo state, then empties the stack", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const loop = makeChangeLoop(makeConfig());
    await runChangeTurn(loop);
    await loop.undoLastTurn();
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("before");

    const redo = await loop.redoLastUndo();

    expect(redo?.ok).toBe(true);
    expect(redo?.files).toBe(2);
    expect(redo?.label).toContain("change files");
    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("after");
    expect(existsSync(path.join(dir, "bash-made.txt"))).toBe(true);
    expect(loop.peekRedo()).toBeNull();
    expect(await loop.redoLastUndo()).toBeNull();
  });

  it("loadMessages clears the redo stack", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const loop = makeChangeLoop(makeConfig());
    await runChangeTurn(loop);
    await loop.undoLastTurn();
    expect(loop.peekRedo()).not.toBeNull();

    await loop.loadMessages([]);
    expect(loop.peekRedo()).toBeNull();
  });

  it("setSessionStore clears the redo stack", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const loop = makeChangeLoop(makeConfig());
    await runChangeTurn(loop);
    await loop.undoLastTurn();
    expect(loop.peekRedo()).not.toBeNull();

    loop.setSessionStore(null);
    expect(loop.peekRedo()).toBeNull();
  });
});
