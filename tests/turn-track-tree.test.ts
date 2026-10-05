import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../src/core/events";

// The tree capture is mocked to a promise the test resolves by hand, so the
// ordering "first model request out, tools held until the capture settles"
// is asserted deterministically instead of by racing real git processes.
const trackTreeMock = vi.hoisted(() => vi.fn());

vi.mock("../src/snapshot/git-tree", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/snapshot/git-tree")>();
  return { ...original, trackTree: trackTreeMock };
});

const { AgentLoop } = await import("../src/agent/loop");
const { createDefaultRegistry } = await import("../src/tools");

type StarConfig = import("../src/config/schema").StarConfig;

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

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "truncate",
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

describe("turn-start tree capture timing", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-track-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-track-home-"));
    vi.stubEnv("STAR_HOME", home);
    trackTreeMock.mockReset();
    trackTreeMock.mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { rmWithRetry } = await import("./test-fs");
    await rmWithRetry(cwd);
    await rmWithRetry(home);
  });

  function makeLoop(rounds: Chunk[][], configOverrides: Partial<StarConfig> = {}) {
    let streamCalls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        streamCalls++;
        const chunks = rounds[Math.min(streamCalls - 1, rounds.length - 1)] ?? [];
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(configOverrides),
      cwd,
      retryDelayMs: 1,
    });
    return { loop, streamCalls: () => streamCalls };
  }

  it("sends the first model request immediately and holds tools until the capture settles", async () => {
    let resolveTrack: (tree: string | null) => void = () => {};
    trackTreeMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveTrack = resolve;
        }),
    );
    const { loop, streamCalls } = makeLoop([
      toolCallRound("c1", "write_file", { path: "out.txt", content: "data" }),
      textRound("done"),
    ]);

    const eventsPromise = collect(loop.stream("write out.txt", new AbortController().signal));

    // The model is reached while the capture is still pending — with the old
    // serial await this wait would time out instead.
    await vi.waitFor(() => expect(streamCalls()).toBe(1), { timeout: 5000 });
    expect(trackTreeMock).toHaveBeenCalledTimes(1);
    // The capture has not settled, so the tool must not have executed.
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);

    resolveTrack("tree-abc");
    const events = await eventsPromise;

    expect(readFileSync(path.join(cwd, "out.txt"), "utf8")).toBe("data");
    expect(events.some((e) => e.type === "tool-result" && !e.isError)).toBe(true);
    // …and the settled tree landed on the turn's marker for /undo.
    expect(loop.previewLastTurnRetraction().tree).toBe("tree-abc");
  });

  it("lets the turn proceed with the per-file fallback when the capture fails", async () => {
    trackTreeMock.mockResolvedValue(null);
    const { loop } = makeLoop([
      toolCallRound("c1", "write_file", { path: "x.txt", content: "after" }),
      textRound("done"),
    ]);
    writeFileSync(path.join(cwd, "x.txt"), "before", "utf8");

    await collect(loop.stream("change x", new AbortController().signal));

    expect(readFileSync(path.join(cwd, "x.txt"), "utf8")).toBe("after");
    expect(loop.previewLastTurnRetraction().tree).toBeUndefined();
    // /undo falls back to per-file snapshots, exactly like a git failure before.
    const outcome = await loop.undoLastTurn();
    expect(outcome.tree).toBeUndefined();
    expect(readFileSync(path.join(cwd, "x.txt"), "utf8")).toBe("before");
  });

  it("never starts a capture when git snapshots are disabled", async () => {
    const { loop } = makeLoop(
      [toolCallRound("c1", "write_file", { path: "o.txt", content: "d" }), textRound("done")],
      {
        gitSnapshots: false,
      },
    );

    await collect(loop.stream("go", new AbortController().signal));

    expect(trackTreeMock).not.toHaveBeenCalled();
    expect(existsSync(path.join(cwd, "o.txt"))).toBe(true);
  });

  it("keeps a late-settling capture from patching another turn's marker", async () => {
    const deferreds: Array<(tree: string | null) => void> = [];
    trackTreeMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          deferreds.push(resolve);
        }),
    );
    const { loop } = makeLoop([textRound("one"), textRound("two")]);

    // A text-only turn ends without ever awaiting its capture.
    await collect(loop.stream("first", new AbortController().signal));
    await loop.retractLastTurn();
    // The next turn reuses the same user-message index — the collision a
    // coordinate-based guard would misattribute the late tree under.
    await collect(loop.stream("second", new AbortController().signal));
    expect(trackTreeMock).toHaveBeenCalledTimes(2);

    deferreds[0]?.("tree-turn-1");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(loop.previewLastTurnRetraction().tree).toBeUndefined();

    deferreds[1]?.("tree-turn-2");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(loop.previewLastTurnRetraction().tree).toBe("tree-turn-2");
  });
});
