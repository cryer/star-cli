import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModel } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentTaskManager,
  type AgentTaskSnapshot,
  defaultAgentTasks,
  formatAgentTaskUpdate,
} from "../src/agent/agent-tasks";
import { AgentLoop, type AgentLoopOptions } from "../src/agent/loop";
import { convertUsagePricing } from "../src/agent/subagent";
import type { ModelConfig, StarConfig } from "../src/config/schema";
import type { StreamEvent, TokenUsage } from "../src/core/events";
import { usageTotalTokens } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";
import type { ToolRegistry } from "../src/tools";
import { createTodoTools, resetTodos } from "../src/tools/todo";

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
      usage: { promptTokens: number; completionTokens: number; totalTokens?: number };
    };

function textRound(text: string): Chunk[] {
  return [
    { type: "text-delta", textDelta: text },
    {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 3 },
    },
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

describe("subagent tool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-subagent-test-"));
  });

  afterEach(() => {
    defaultAgentTasks.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(
    model: MockLanguageModelV1,
    configOverrides: Partial<StarConfig> = {},
    loopOverrides: Partial<AgentLoopOptions> = {},
  ): { loop: AgentLoop; registry: ToolRegistry } {
    const registry = createDefaultRegistry();
    const loop = new AgentLoop({
      model,
      registry,
      config: makeConfig(configOverrides),
      cwd,
      ...loopOverrides,
    });
    return { loop, registry };
  }

  it("registers the subagent tool on the main loop", () => {
    const { registry } = makeLoop(mockModel([textRound("hi")]));
    expect(registry.get("subagent")).toBeDefined();
  });

  it("runs a subagent and returns its report as the tool result", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", {
          prompt: "investigate the repo",
          description: "repo survey",
        }),
        textRound("subagent report: all quiet"),
        textRound("parent done"),
      ]),
    );

    const events = await collect(loop.stream("survey the repo", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ name: "subagent" });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("subagent report: all quiet");
      expect(toolResult.content).toContain('"repo survey"');
    }

    const text = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e.type === "text-delta" ? e.text : ""))
      .join("");
    expect(text).toBe("parent done");
  });

  it("lets the subagent use tools in its own loop", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "hello from file", "utf8");
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "read note.txt and report" }),
        toolCallRound("call-2", "read_file", { path: "note.txt" }),
        textRound("the file says hello"),
        textRound("parent done"),
      ]),
    );

    const events = await collect(loop.stream("check note.txt", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("the file says hello");
      expect(toolResult.content).toContain("1 tool call(s)");
    }
  });

  it("restricts a read_only subagent to read-level tools", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "hello from file", "utf8");
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "read the note", read_only: true }),
        toolCallRound("call-2", "read_file", { path: "note.txt" }),
        textRound("the note says hello"),
        textRound("parent done"),
      ]),
    );

    const events = await collect(loop.stream("go", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("the note says hello");
      expect(toolResult.content).toContain("read-only");
      expect(toolResult.content).toContain("1 tool call(s)");
    }
  });

  it("fails a read_only subagent's write attempt without touching the disk", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "fix it", read_only: true }),
        // Write tools are hidden from the child's tool map, so the SDK
        // rejects the call outright instead of executing it.
        toolCallRound("call-2", "write_file", { path: "blocked.txt", content: "x" }),
        textRound("parent done"),
      ]),
    );

    const events = await collect(loop.stream("go", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBe(true);
      expect(toolResult.content).toContain("unavailable tool 'write_file'");
    }
    expect(existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
  });

  it("does not register the subagent tool at max depth", () => {
    const { registry } = makeLoop(mockModel([textRound("hi")]), {}, { subagentDepth: 1 });
    expect(registry.get("subagent")).toBeUndefined();
  });

  it("gives a subagent loop an isolated in-memory todo store", async () => {
    resetTodos();
    try {
      const { loop } = makeLoop(
        mockModel([
          toolCallRound("call-1", "todo_write", {
            todos: [{ id: 1, title: "child task", status: "pending" }],
          }),
          textRound("done"),
        ]),
        {},
        { subagentDepth: 1 },
      );

      await collect(loop.stream("work", new AbortController().signal));

      // The write went to the child's own store: the process-wide default
      // store behind the parent's todo tools stays empty.
      const todoRead = createTodoTools().find((tool) => tool.name === "todo_read");
      const result = await todoRead?.execute({}, { cwd });
      expect(result?.content).toBe("No todos.");
    } finally {
      resetTodos();
    }
  });

  it("surfaces a subagent failure as an error tool result", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "do something" }),
        toolCallRound("call-2", "nope_tool", {}),
        textRound("parent recovered"),
      ]),
    );

    const events = await collect(loop.stream("run subtask", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toMatchObject({ isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("Subagent failed");
    }
  });

  it("is denied in readonly mode", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "do something" }),
        textRound("parent done"),
      ]),
      { permissionMode: "readonly" },
    );

    const events = await collect(loop.stream("run subtask", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toMatchObject({ isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("Permission denied");
    }
  });

  it("is hidden from the model in plan mode", async () => {
    const { loop } = makeLoop(
      mockModel([toolCallRound("call-1", "subagent", { prompt: "do something" })]),
      { permissionMode: "plan" },
    );

    const events = await collect(loop.stream("run subtask", new AbortController().signal));

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") {
      expect(error.error.message).toContain("unavailable tool 'subagent'");
    }
    expect(events.some((e) => e.type === "tool-result")).toBe(false);
  });

  it("runs a subagent in the background and returns a task id immediately", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", {
          prompt: "investigate the repo",
          description: "repo survey",
          run_in_background: true,
        }),
        textRound("spawned the survey"),
        textRound("spawned the survey"),
      ]),
    );

    const events = await collect(loop.stream("survey in background", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("Background subagent agent-");
      expect(toolResult.content).toContain('"repo survey"');
    }
    // The child runs on the same mock model and finishes by itself.
    for (let i = 0; i < 50 && defaultAgentTasks.runningCount() > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(defaultAgentTasks.runningCount()).toBe(0);
  });

  it("delivers finished background subagent reports at the next step boundary", async () => {
    defaultAgentTasks.start(() => Promise.resolve("child report: 42 files"), {
      prompt: "count files",
      description: "file count",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const { loop } = makeLoop(
      mockModel([toolCallRound("call-1", "todo_read", {}), textRound("done")]),
    );

    await collect(loop.stream("continue working", new AbortController().signal));

    const note = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("child report: 42 files"),
      );
    expect(note).toBeDefined();
    if (note && typeof note.content === "string") {
      expect(note.content).toContain('"file count"');
      expect(note.content).toContain("completed");
    }
  });

  it("folds a synchronous subagent's usage into the parent's finish events", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "investigate the repo" }),
        textRound("child report"),
        textRound("parent done"),
      ]),
    );

    const events = await collect(loop.stream("survey", new AbortController().signal));

    const finishes = events.filter((e) => e.type === "finish");
    expect(finishes).toHaveLength(2);
    // The parent's own first step reports only its own usage…
    expect(finishes[0]).toMatchObject({ usage: { promptTokens: 5, completionTokens: 3 } });
    // …and the step after the subagent ran carries the child's 5/3 on top.
    expect(finishes[1]).toMatchObject({ usage: { promptTokens: 10, completionTokens: 6 } });
    const promptTotal = finishes.reduce(
      (sum, e) => sum + (e.type === "finish" ? (e.usage?.promptTokens ?? 0) : 0),
      0,
    );
    expect(promptTotal).toBe(15);
  });

  it("bills a background subagent that finishes after the parent turn ended", async () => {
    const { loop } = makeLoop(
      mockModel([
        toolCallRound("call-1", "subagent", { prompt: "bg work", run_in_background: true }),
        textRound("spawned"),
        textRound("child report"),
        textRound("turn two done"),
      ]),
    );

    const events1 = await collect(loop.stream("turn one", new AbortController().signal));
    for (let i = 0; i < 100 && defaultAgentTasks.runningCount() > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(defaultAgentTasks.runningCount()).toBe(0);
    const events2 = await collect(loop.stream("turn two", new AbortController().signal));

    // The child's 5/3 landed after turn one's finishes had a chance to fold
    // it, so it rides on turn two's first finish. Wherever it folded, the
    // session total bills parent (3 steps) + child (1 step).
    const finishes = [...events1, ...events2].filter((e) => e.type === "finish");
    const promptTotal = finishes.reduce(
      (sum, e) => sum + (e.type === "finish" ? (e.usage?.promptTokens ?? 0) : 0),
      0,
    );
    expect(promptTotal).toBe(20);
    const folded = finishes.filter((e) => e.type === "finish" && e.usage?.promptTokens === 10);
    expect(folded).toHaveLength(1);
  });

  it("reports an aborted synchronous subagent as an interrupted tool result", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        call += 1;
        if (call === 1) {
          return {
            stream: convertArrayToReadableStream(
              toolCallRound("call-1", "subagent", { prompt: "do slow work" }),
            ),
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        }
        // The child loop streams one partial chunk, then hangs until aborted.
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "child partial" });
              const cut = () => {
                try {
                  controller.enqueue({
                    type: "error",
                    error: new Error("This operation was aborted"),
                  });
                  controller.close();
                } catch {
                  // already closed
                }
              };
              if (options.abortSignal?.aborted) cut();
              else options.abortSignal?.addEventListener("abort", cut, { once: true });
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const { loop } = makeLoop(model);

    const controller = new AbortController();
    const events: StreamEvent[] = [];
    for await (const event of loop.stream("run subtask", controller.signal)) {
      events.push(event);
      if (event.type === "tool-call") setTimeout(() => controller.abort(), 20);
    }

    const toolResult = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    expect(toolResult).toMatchObject({ isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toBe("Tool execution aborted.");
    }
  });
});

describe("convertUsagePricing", () => {
  const fakeModel = (modelId: string): LanguageModel => ({ modelId }) as LanguageModel;
  const priced = (model: string, promptPrice: number, completionPrice: number): ModelConfig => ({
    name: model,
    provider: "p",
    model,
    promptPrice,
    completionPrice,
  });
  const configWith = (models: ModelConfig[]): StarConfig => makeConfig({ models });
  const usage: TokenUsage = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };

  it("passes usage through untouched when parent and child share the model", () => {
    const m = fakeModel("same");
    expect(convertUsagePricing(usage, m, m, configWith([]))).toBe(usage);
  });

  it("re-expresses tokens in parent-priced equivalents, preserving dollars", () => {
    const config = configWith([priced("child", 4, 16), priced("parent", 2, 4)]);
    const converted = convertUsagePricing(usage, fakeModel("child"), fakeModel("parent"), config);
    // 100 prompt @4 → 200 @2; 50 completion @16 → 200 @4.
    expect(converted).toEqual({ promptTokens: 200, completionTokens: 200, totalTokens: 400 });
  });

  it("converts cache token classes at their own price ratios", () => {
    const child: ModelConfig = { ...priced("child", 2, 2), cacheReadPrice: 1 };
    const parent: ModelConfig = { ...priced("parent", 2, 4), cacheReadPrice: 1 };
    const config = configWith([child, parent]);
    const withCache: TokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 160,
      cachedPromptTokens: 40,
      cacheReadInputTokens: 10,
    };
    const converted = convertUsagePricing(
      withCache,
      fakeModel("child"),
      fakeModel("parent"),
      config,
    );
    // uncached 60 @2 → 60 @2; cached 40 @1 → 40 @1; cache-read 10 @1 → 10 @1;
    // completion 50 @2 → 25 @4.
    expect(converted).toEqual({
      promptTokens: 100,
      completionTokens: 25,
      totalTokens: 125,
      cachedPromptTokens: 40,
      cacheReadInputTokens: 10,
    });
  });

  it("folds cache-read dollars into completion when the parent has no cache-read price", () => {
    const child: ModelConfig = { ...priced("child", 2, 2), cacheReadPrice: 1 };
    const config = configWith([child, priced("parent", 2, 2)]);
    const withCache: TokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 160,
      cachedPromptTokens: 40,
      cacheReadInputTokens: 10,
    };
    const converted = convertUsagePricing(
      withCache,
      fakeModel("child"),
      fakeModel("parent"),
      config,
    );
    // cached 40 @1 → 20 @2 (parent effective cache price = promptPrice);
    // cache-read 10 @1 unbillable on the parent → +5 completion tokens.
    expect(converted).toEqual({
      promptTokens: 80,
      completionTokens: 55,
      totalTokens: 135,
      cachedPromptTokens: 20,
    });
  });

  it("falls back to raw token sums when either side lacks full pricing", () => {
    const config = configWith([
      priced("child", 4, 16),
      { name: "parent", provider: "p", model: "parent" },
    ]);
    expect(convertUsagePricing(usage, fakeModel("child"), fakeModel("parent"), config)).toBe(usage);
    const zeroParent = configWith([priced("child", 4, 16), priced("parent", 0, 0)]);
    expect(convertUsagePricing(usage, fakeModel("child"), fakeModel("parent"), zeroParent)).toBe(
      usage,
    );
  });

  it("prices by the [[models]] entry names when two entries share one model id", () => {
    const dear = { ...priced("shared", 4, 16), name: "dear" };
    const cheap = { ...priced("shared", 2, 4), name: "cheap" };
    const config = configWith([dear, cheap]);
    // Same model id on both sides: the id-only lookup cannot tell the runs
    // apart and converts dear -> dear (a no-op). The entry names convert
    // dear -> cheap: 100 prompt @4 → 200 @2; 50 completion @16 → 200 @4.
    const converted = convertUsagePricing(usage, fakeModel("shared"), fakeModel("shared"), config, {
      fromName: "dear",
      toName: "cheap",
    });
    expect(converted).toEqual({ promptTokens: 200, completionTokens: 200, totalTokens: 400 });
  });

  it("falls back to the model-id lookup when the named entry is gone", () => {
    const config = configWith([priced("child", 4, 16), priced("parent", 2, 4)]);
    const converted = convertUsagePricing(usage, fakeModel("child"), fakeModel("parent"), config, {
      fromName: "renamed-away",
    });
    expect(converted).toEqual({ promptTokens: 200, completionTokens: 200, totalTokens: 400 });
  });
});

describe("usageTotalTokens", () => {
  it("sums the billed classes, ignoring extra classes inside a reported total", () => {
    // 10 reasoning tokens inside totalTokens must not bill twice.
    expect(usageTotalTokens({ promptTokens: 5, completionTokens: 3, totalTokens: 18 })).toBe(8);
  });

  it("falls back to the reported total for a total-only report", () => {
    expect(usageTotalTokens({ promptTokens: 0, completionTokens: 0, totalTokens: 12 })).toBe(12);
  });
});

describe("subagent usage folding normalization", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-subagent-fold-"));
  });

  afterEach(() => {
    defaultAgentTasks.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("does not double-bill reasoning classes hidden inside totalTokens", async () => {
    // Every finish reports 10 reasoning tokens on top of the billed 5/3.
    const withRichUsage = (chunks: Chunk[]): Chunk[] =>
      chunks.map((chunk) =>
        chunk.type === "finish"
          ? { ...chunk, usage: { promptTokens: 5, completionTokens: 3, totalTokens: 18 } }
          : chunk,
      );
    const loop = new AgentLoop({
      model: mockModel([
        withRichUsage(toolCallRound("call-1", "subagent", { prompt: "investigate" })),
        withRichUsage(textRound("child report")),
        withRichUsage(textRound("parent done")),
      ]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });

    const events = await collect(loop.stream("survey", new AbortController().signal));

    const finishes = events.filter(
      (e): e is Extract<StreamEvent, { type: "finish" }> => e.type === "finish",
    );
    expect(finishes).toHaveLength(2);
    // The step after the child ran folds parent (5/3) + child (5/3); the
    // total sums the billed classes (8+8), not the reported 18+18.
    expect(finishes[1]?.usage).toEqual({ promptTokens: 10, completionTokens: 6, totalTokens: 16 });
  });
});

describe("AgentTaskManager record pruning", () => {
  it("keeps only the 50 most recent notified finished records", async () => {
    const manager = new AgentTaskManager();
    for (let i = 0; i < 60; i++) {
      manager.start(() => Promise.resolve(`result ${i}`), { prompt: `task ${i}` });
    }
    await vi.waitFor(() => {
      expect(manager.runningCount()).toBe(0);
    });
    expect(manager.list()).toHaveLength(60);

    const drained = manager.drainNotifications();
    expect(drained).toHaveLength(60);

    expect(manager.list()).toHaveLength(50);
    expect(manager.get("agent-1")).toBeUndefined();
    expect(manager.get("agent-11")).toBeDefined();
    expect(manager.get("agent-60")?.result).toBe("result 59");
  });

  it("prefers dropping notified records when pruning", async () => {
    const manager = new AgentTaskManager();
    for (let i = 0; i < 60; i++) {
      manager.start(() => Promise.resolve(`result ${i}`), { prompt: `task ${i}` });
    }
    await vi.waitFor(() => {
      expect(manager.runningCount()).toBe(0);
    });
    manager.drainNotifications();

    for (let i = 60; i < 70; i++) {
      manager.start(() => Promise.resolve(`result ${i}`), { prompt: `task ${i}` });
    }
    await vi.waitFor(() => {
      expect(manager.runningCount()).toBe(0);
    });
    manager.drainNotifications();

    expect(manager.list()).toHaveLength(50);
    expect(manager.get("agent-11")).toBeUndefined();
    expect(manager.get("agent-61")).toBeDefined();
  });
});

describe("formatAgentTaskUpdate", () => {
  const task = (overrides: Partial<AgentTaskSnapshot>): AgentTaskSnapshot => ({
    id: "agent-1",
    prompt: "do the thing",
    status: "running",
    startedAt: 0,
    result: "",
    ...overrides,
  });

  it("announces starts and plain completions", () => {
    expect(formatAgentTaskUpdate(task({}))).toBe("Background subagent agent-1 started");
    expect(
      formatAgentTaskUpdate(task({ status: "completed", description: "调研", result: "done" })),
    ).toBe("Background subagent agent-1 completed: 调研");
  });

  it("appends the failure reason, stripping the wrapper prefix", () => {
    const result = [
      "Subagent failed: The model returned an empty response after retries; ending the turn.",
      "[subagent: 13 tool call(s)]",
      "partial report",
    ].join("\n");
    expect(formatAgentTaskUpdate(task({ status: "failed", result }))).toBe(
      "Background subagent agent-1 failed — The model returned an empty response after retries; ending the turn.",
    );
  });

  it("truncates a long failure reason", () => {
    const result = `Subagent failed: ${"x".repeat(300)}`;
    const text = formatAgentTaskUpdate(task({ status: "failed", result }));
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("…");
  });
});
