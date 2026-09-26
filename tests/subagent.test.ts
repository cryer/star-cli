import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentTaskManager, defaultAgentTasks } from "../src/agent/agent-tasks";
import { AgentLoop, type AgentLoopOptions } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
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
      usage: { promptTokens: number; completionTokens: number };
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
