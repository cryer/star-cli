import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent } from "../src/core/events";

// Spy on streamChat to observe the exact references the agent loop hands to
// the stream layer: the memoized request-messages array (reused across stream
// retries) and the memoized ai-tools map (reused across turns).
vi.mock("../src/llm/stream", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/llm/stream")>();
  return {
    ...original,
    streamChat: vi.fn((opts: Parameters<typeof original.streamChat>[0]) =>
      original.streamChat(opts),
    ),
  };
});

const { AgentLoop } = await import("../src/agent/loop");
const { streamChat } = await import("../src/llm/stream");
const { createDefaultRegistry } = await import("../src/tools");
const streamChatMock = vi.mocked(streamChat);

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

// An empty reply (finish with no content and zero billed tokens) is resent by
// the loop with the full retry budget — two model round-trips for one step.
function emptyRound(): Chunk[] {
  return [
    { type: "finish", finishReason: "stop", usage: { promptTokens: 0, completionTokens: 0 } },
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
    gitSnapshots: false,
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

describe("loop per-turn caches", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-perf-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-perf-home-"));
    vi.stubEnv("STAR_HOME", home);
    streamChatMock.mockClear();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    const { rmWithRetry } = await import("./test-fs");
    await rmWithRetry(cwd);
    await rmWithRetry(home);
  });

  function makeLoop(model: MockLanguageModelV1, configOverrides: Partial<StarConfig> = {}) {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(configOverrides),
      cwd,
      retryDelayMs: 1,
    });
  }

  it("reuses the built request messages across a stream retry", async () => {
    const loop = makeLoop(mockModel([emptyRound(), textRound("ok")]));

    await collect(loop.stream("hi", new AbortController().signal));

    expect(streamChatMock.mock.calls.length).toBe(2);
    const first = streamChatMock.mock.calls[0]?.[0];
    const second = streamChatMock.mock.calls[1]?.[0];
    expect(second?.messages).toBe(first?.messages);
  });

  it("rebuilds the request messages once the history grows", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "content", "utf8");
    const loop = makeLoop(
      mockModel([toolCallRound("c1", "read_file", { path: "note.txt" }), textRound("done")]),
    );

    await collect(loop.stream("read note.txt", new AbortController().signal));

    expect(streamChatMock.mock.calls.length).toBe(2);
    const first = streamChatMock.mock.calls[0]?.[0];
    const second = streamChatMock.mock.calls[1]?.[0];
    expect(second?.messages).not.toBe(first?.messages);
    // The second step carries the appended assistant tool-call + tool result.
    expect(second?.messages.length).toBeGreaterThan(first?.messages.length ?? 0);
  });

  it("attaches the git reminder to the outgoing request only, never persisted", async () => {
    const { runGit } = await import("../src/core/git");
    writeFileSync(path.join(cwd, "seed.txt"), "seed", "utf8");
    runGit(["init"], cwd);
    runGit(["add", "-A"], cwd);
    runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"], cwd);
    const loop = makeLoop(mockModel([textRound("ok")]));

    await collect(loop.stream("hi", new AbortController().signal));

    const sent = streamChatMock.mock.calls[0]?.[0].messages ?? [];
    const lastUser = [...sent].reverse().find((m) => m.role === "user");
    expect(JSON.stringify(lastUser)).toContain("<system-reminder>");
    // The persisted history view stays free of the request-scoped block.
    expect(JSON.stringify(loop.getMessages())).not.toContain("<system-reminder>");
  });

  it("reuses the built ai-tools map across turns and rebuilds on a mode switch", async () => {
    const config = makeConfig();
    const loop = new AgentLoop({
      model: mockModel([textRound("one"), textRound("two"), textRound("three")]),
      registry: createDefaultRegistry(),
      config,
      cwd,
      retryDelayMs: 1,
    });

    await collect(loop.stream("first", new AbortController().signal));
    await collect(loop.stream("second", new AbortController().signal));
    expect(streamChatMock.mock.calls.length).toBe(2);
    const toolsFirst = streamChatMock.mock.calls[0]?.[0].tools;
    expect(streamChatMock.mock.calls[1]?.[0].tools).toBe(toolsFirst);

    config.permissionMode = "plan";
    await collect(loop.stream("third", new AbortController().signal));
    const toolsPlan = streamChatMock.mock.calls[2]?.[0].tools ?? {};
    expect(toolsPlan).not.toBe(toolsFirst);
    expect(Object.keys(toolsPlan)).toContain("read_file");
    expect(Object.keys(toolsPlan)).not.toContain("write_file");
  });

  it("charges tool schema tokens into the auto-compaction threshold", async () => {
    // History ≈ 130 estimated tokens: under the 300-token threshold alone,
    // over it once the ~2k tool-schema overhead is counted.
    const loop = makeLoop(mockModel([textRound("ok")]), {
      compactThresholdTokens: 300,
      contextMaxTokens: 100_000,
    });
    await loop.loadMessages([
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "x".repeat(400) },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);

    await collect(loop.stream("hi", new AbortController().signal));

    expect(
      loop
        .getMessages()
        .some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith("[context compacted:"),
        ),
    ).toBe(true);
  });

  it("does not compact a similar history when the threshold leaves room for the overhead", async () => {
    // Control for the test above: same history, threshold above
    // history + ~2k schema overhead → no compaction.
    const loop = makeLoop(mockModel([textRound("ok")]), {
      compactThresholdTokens: 10_000,
      contextMaxTokens: 100_000,
    });
    await loop.loadMessages([
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "x".repeat(400) },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);

    await collect(loop.stream("hi", new AbortController().signal));

    expect(loop.getMessages()[0]?.content).toBe("x".repeat(400));
  });
});
