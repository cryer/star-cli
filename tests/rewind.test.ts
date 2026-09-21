import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { formatCheckpointList, planRewind } from "../src/cli/commands/rewind";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { listCheckpointRecords, loadSessionSnapshots } from "../src/session/checkpoints";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import {
  beginTurn,
  clearSnapshots,
  hydrateSnapshots,
  listSnapshots,
  rewindToSnapshot,
  setSnapshotHooks,
  snapshotCount,
} from "../src/tools/fs/snapshots";
import { writeFileTool } from "../src/tools/fs/write";

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

function makeConfig(): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    permissions: { allow: [] },
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

function ctx() {
  return { cwd: dir };
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "star-rewind-home-"));
  dir = mkdtempSync(path.join(os.tmpdir(), "star-rewind-"));
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

describe("checkpoint persistence", () => {
  it("creates the checkpoints directory lazily on the first checkpoint", async () => {
    const store = await SessionStore.create(dir, "test-model");
    await store.append({ role: "user", content: "hi" });
    expect(existsSync(path.join(store.dir, "checkpoints"))).toBe(false);

    await store.appendCheckpoint(
      {
        id: 1,
        timestamp: Date.now(),
        path: path.join(dir, "a.txt"),
        existed: true,
        toolName: "write_file",
        turn: 1,
        messageIndex: 0,
      },
      "old content",
    );
    expect(existsSync(path.join(store.dir, "checkpoints", "index.json"))).toBe(true);

    const records = await store.listCheckpoints();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 1, toolName: "write_file", messageIndex: 0 });
  });

  it("removes checkpoint records and their content files", async () => {
    const store = await SessionStore.create(dir, "test-model");
    const record = (id: number) => ({
      id,
      timestamp: Date.now(),
      path: path.join(dir, `f${id}.txt`),
      existed: true,
      toolName: "write_file",
      turn: id,
      messageIndex: 0,
    });
    await store.appendCheckpoint(record(1), "one");
    await store.appendCheckpoint(record(2), "two");
    await store.appendCheckpoint(record(3), "three");

    await store.removeCheckpoints([2, 3]);

    expect((await store.listCheckpoints()).map((r) => r.id)).toEqual([1]);
    expect(existsSync(path.join(store.dir, "checkpoints", "2.snapshot"))).toBe(false);
    expect(existsSync(path.join(store.dir, "checkpoints", "1.snapshot"))).toBe(true);
  });

  it("persists a checkpoint when the agent loop writes a file", async () => {
    writeFileSync(path.join(dir, "x.txt"), "before");
    const store = await SessionStore.create(dir, "test-model");
    const loop = new AgentLoop({
      model: mockModel([
        toolCallRound("c1", "write_file", { path: "x.txt", content: "after" }),
        textRound("done"),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd: dir,
      sessionStore: store,
    });

    await collect(loop.stream("update x.txt", new AbortController().signal));

    expect(readFileSync(path.join(dir, "x.txt"), "utf8")).toBe("after");
    const records = await store.listCheckpoints();
    expect(records).toHaveLength(1);
    expect(records[0]?.path).toBe(path.join(dir, "x.txt"));
    expect(records[0]?.messageIndex).toBe(0);
    expect(
      readFileSync(path.join(store.dir, "checkpoints", `${records[0]?.id}.snapshot`), "utf8"),
    ).toBe("before");
  });
});

describe("rewindToSnapshot", () => {
  it("restores modified files and deletes files created after the checkpoint", async () => {
    writeFileSync(path.join(dir, "f.txt"), "v0");
    beginTurn(0);
    await writeFileTool.execute({ path: "f.txt", content: "v1" }, ctx());
    beginTurn(2);
    await writeFileTool.execute({ path: "g.txt", content: "new" }, ctx());

    const snapshots = listSnapshots();
    expect(snapshots).toHaveLength(2);
    const result = await rewindToSnapshot(snapshots[1]?.id ?? -1);

    expect(result).not.toBeNull();
    expect(existsSync(path.join(dir, "g.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("v1");
    expect(result?.messageIndex).toBe(2);
    expect(snapshotCount()).toBe(1);

    const earlier = await rewindToSnapshot(snapshots[0]?.id ?? -1);
    expect(readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("v0");
    expect(earlier?.messageIndex).toBe(0);
    expect(snapshotCount()).toBe(0);
  });

  it("returns null for an unknown checkpoint id", async () => {
    expect(await rewindToSnapshot(99999)).toBeNull();
  });

  it("drops rewound checkpoints from the persisted store too", async () => {
    const store = await SessionStore.create(dir, "test-model");
    // Constructing the loop binds the snapshot persistence hooks to the store.
    new AgentLoop({
      model: mockModel([textRound("x")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd: dir,
      sessionStore: store,
    });
    writeFileSync(path.join(dir, "f.txt"), "v0");
    beginTurn(0);
    await writeFileTool.execute({ path: "f.txt", content: "v1" }, ctx());
    await writeFileTool.execute({ path: "f.txt", content: "v2" }, ctx());
    expect(await listCheckpointRecords(store.dir)).toHaveLength(2);

    const snapshots = listSnapshots();
    await rewindToSnapshot(snapshots[1]?.id ?? -1);

    expect((await listCheckpointRecords(store.dir)).map((r) => r.id)).toEqual([snapshots[0]?.id]);
    expect(readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("v1");
  });
});

describe("rewind after session resume", () => {
  it("restores files from persisted checkpoints with no in-memory snapshots", async () => {
    const store = await SessionStore.create(dir, "test-model");
    new AgentLoop({
      model: mockModel([textRound("x")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd: dir,
      sessionStore: store,
    });
    writeFileSync(path.join(dir, "f.txt"), "v0");
    beginTurn(0);
    await writeFileTool.execute({ path: "f.txt", content: "v1" }, ctx());
    await writeFileTool.execute({ path: "created.txt", content: "data" }, ctx());

    // Simulate a fresh process resuming the session: no in-memory snapshots.
    setSnapshotHooks(null);
    clearSnapshots();
    const reopened = await SessionStore.open(store.id);
    expect(reopened).not.toBeNull();
    if (!reopened) return;
    hydrateSnapshots(await loadSessionSnapshots(reopened.dir));

    const snapshots = listSnapshots();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]?.content).toBeNull();
    const result = await rewindToSnapshot(snapshots[0]?.id ?? -1);

    expect(result).not.toBeNull();
    expect(readFileSync(path.join(dir, "f.txt"), "utf8")).toBe("v0");
    expect(existsSync(path.join(dir, "created.txt"))).toBe(false);
    expect(snapshotCount()).toBe(0);
  });
});

describe("message retraction", () => {
  it("retractFromIndex truncates history and the persisted JSONL", async () => {
    const store = await SessionStore.create(dir, "test-model");
    const loop = new AgentLoop({
      model: mockModel([textRound("answer one"), textRound("answer two")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd: dir,
      sessionStore: store,
    });
    await collect(loop.stream("first", new AbortController().signal));
    await collect(loop.stream("second", new AbortController().signal));
    expect(loop.getMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    expect(loop.countRetraction(2)).toBe(2);
    const removed = await loop.retractFromIndex(2);

    expect(removed).toBe(2);
    expect(loop.getMessages().map((m) => m.role)).toEqual(["user", "assistant"]);
    const reopened = await SessionStore.open(store.id);
    expect((await reopened?.messages())?.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("walks back to the nearest user message when the index drifts", async () => {
    const loop = new AgentLoop({
      model: mockModel([textRound("a1"), textRound("a2")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd: dir,
    });
    await collect(loop.stream("first", new AbortController().signal));
    await collect(loop.stream("second", new AbortController().signal));

    // Index 3 points at the second assistant message; the cut must land on
    // the user message that started that turn.
    const removed = await loop.retractFromIndex(3);
    expect(removed).toBe(2);
    expect(loop.getMessages()).toHaveLength(2);
  });
});

describe("rewind planning and formatting", () => {
  it("planRewind selects the target and all later checkpoints", () => {
    writeFileSync(path.join(dir, "f.txt"), "v0");
    const snapshot = (id: number, messageIndex: number) => ({
      id,
      path: path.join(dir, `f${id}.txt`),
      existed: true,
      content: "x",
      toolName: "write_file",
      timestamp: Date.now(),
      turn: id,
      messageIndex,
    });
    const snapshots = [snapshot(10, 0), snapshot(11, -1), snapshot(12, 4)];

    const plan = planRewind(snapshots, 11);
    expect(plan?.affected.map((s) => s.id)).toEqual([11, 12]);
    // -1 means "no turn context" and is ignored for the conversation cut.
    expect(plan?.messageIndex).toBe(4);
    expect(planRewind(snapshots, 99)).toBeNull();
  });

  it("formatCheckpointList renders checkpoints with relative paths", () => {
    const output = formatCheckpointList(
      [
        {
          id: 7,
          path: path.join(dir, "src", "a.ts"),
          existed: true,
          content: "x",
          toolName: "edit_file",
          timestamp: new Date("2025-06-01T14:03:05").getTime(),
          turn: 3,
          messageIndex: 2,
        },
        {
          id: 8,
          path: path.join(dir, "new.ts"),
          existed: false,
          content: null,
          toolName: "write_file",
          timestamp: new Date("2025-06-01T14:04:00").getTime(),
          turn: 3,
          messageIndex: 2,
        },
      ],
      dir,
    );
    expect(output).toContain("#7");
    expect(output).toContain("edit_file");
    expect(output).toContain(path.join("src", "a.ts"));
    expect(output).toContain("#8");
    expect(output).toContain("write_file (new file)");
    expect(output).toContain("/rewind <n>");
  });

  it("formatCheckpointList explains the empty state", () => {
    expect(formatCheckpointList([], dir)).toContain("No checkpoints yet");
  });
});
