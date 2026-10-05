import { tmpdir } from "node:os";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAgentTasks } from "../src/agent/agent-tasks";
import { AgentLoop, type AgentLoopOptions } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { TaskManager, type TaskSnapshot, defaultTaskManager } from "../src/tasks/manager";
import { createDefaultRegistry } from "../src/tools";
import type { ToolContext, ToolResult } from "../src/tools/types";

// These tests never touch the filesystem — commands are all sleepers — so a
// stable shared cwd avoids the Windows race of rm-ing a temp dir while
// killed child processes still hold a handle to it.
const cwd = tmpdir();
const registry = createDefaultRegistry();

afterEach(() => {
  defaultTaskManager.cleanup();
  defaultAgentTasks.cleanup();
});

const SLEEPER = 'node -e "setTimeout(() => {}, 30000)"';

function run(
  name: string,
  args: Record<string, unknown>,
  ctx: Partial<ToolContext> = {},
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args as never, { cwd, ...ctx });
}

describe("TaskManager ownership", () => {
  it("records the owner id, defaulting to root", () => {
    const manager = new TaskManager();
    const rootTask = manager.start({ command: SLEEPER, cwd });
    expect(rootTask.ownerId).toBe("root");
    const subTask = manager.start({ command: SLEEPER, cwd, ownerId: "agent-3" });
    expect(subTask.ownerId).toBe("agent-3");
    expect(manager.get(subTask.id)?.ownerId).toBe("agent-3");
    manager.cleanup();
  });
});

describe("task_* ownership scoping", () => {
  const sub = { agentId: "agent-7" };

  it("a subagent cannot kill, read, or list root's tasks", async () => {
    const started = await run("bash", { command: SLEEPER, run_in_background: true });
    const rootId = started.content.match(/Background task started: (task-\d+)/)?.[1] as string;

    const kill = await run("task_kill", { id: rootId }, sub);
    expect(kill.isError).toBe(true);
    expect(kill.content).toContain("Unknown task");
    expect(defaultTaskManager.get(rootId)?.status).toBe("running");

    const output = await run("task_output", { id: rootId }, sub);
    expect(output.isError).toBe(true);
    expect(output.content).toContain("Unknown task");

    const list = await run("task_list", {}, sub);
    expect(list.content).not.toContain(rootId);

    // Root still sees and controls it.
    expect((await run("task_list", {})).content).toContain(rootId);
    const rootKill = await run("task_kill", { id: rootId });
    expect(rootKill.isError).toBeUndefined();
    expect(rootKill.content).toContain("stopped");
  });

  it("a subagent kills its own tasks, and root can kill the subagent's", async () => {
    const started = await run(
      "bash",
      { command: SLEEPER, run_in_background: true },
      { agentId: "agent-7" },
    );
    const ownId = started.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    expect(defaultTaskManager.get(ownId)?.ownerId).toBe("agent-7");

    const ownKill = await run("task_kill", { id: ownId }, { agentId: "agent-7" });
    expect(ownKill.isError).toBeUndefined();
    expect(ownKill.content).toContain("stopped");

    const second = await run(
      "bash",
      { command: SLEEPER, run_in_background: true },
      { agentId: "agent-7" },
    );
    const secondId = second.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    // A different subagent may not kill it.
    const sibling = await run("task_kill", { id: secondId }, { agentId: "agent-9" });
    expect(sibling.isError).toBe(true);
    // Root can.
    const byRoot = await run("task_kill", { id: secondId });
    expect(byRoot.isError).toBeUndefined();
  });

  it("task_list shows a subagent only its own tasks", async () => {
    const root = await run("bash", { command: SLEEPER, run_in_background: true });
    const rootId = root.content.match(/Background task started: (task-\d+)/)?.[1] as string;
    const own = await run(
      "bash",
      { command: SLEEPER, run_in_background: true },
      { agentId: "agent-7" },
    );
    const ownId = own.content.match(/Background task started: (task-\d+)/)?.[1] as string;

    const list = await run("task_list", {}, { agentId: "agent-7" });
    expect(list.content).toContain(ownId);
    expect(list.content).not.toContain(rootId);
    // Subagents never see root's background subagents.
    expect(list.content).toContain("No background subagents.");
  });

  it("background subagent tasks belong to root only", async () => {
    const agent = defaultAgentTasks.start(() => new Promise<string>(() => {}), {
      prompt: "never resolves",
    });
    const denied = await run("task_kill", { id: agent.id }, { agentId: agent.id });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("Unknown task");
    const byRoot = await run("task_kill", { id: agent.id });
    expect(byRoot.isError).toBeUndefined();
  });
});

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

// Routes stream calls by system prompt: the child loop's system prompt
// contains the subagent preamble, so parent and child get their own round
// sequences even though they share one mock model instance.
function routingModel(parentRounds: Chunk[][], childRounds: Chunk[][]): MockLanguageModelV1 {
  let parentCall = 0;
  let childCall = 0;
  return new MockLanguageModelV1({
    doStream: async (options) => {
      const isChild = JSON.stringify(options.prompt[0] ?? {}).includes("subagent spawned");
      const rounds = isChild ? childRounds : parentRounds;
      const call = isChild ? childCall++ : parentCall++;
      const chunks = rounds[Math.min(call, rounds.length - 1)] ?? [];
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

function makeLoop(
  model: MockLanguageModelV1,
  loopOverrides: Partial<AgentLoopOptions> = {},
): AgentLoop {
  return new AgentLoop({
    model,
    registry: createDefaultRegistry(),
    config: makeConfig(),
    cwd,
    ...loopOverrides,
  });
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

async function waitForNoRunningAgents(): Promise<void> {
  for (let i = 0; i < 500 && defaultAgentTasks.runningCount() > 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// First stream call returns the tool-call round, later calls a text round,
// so the turn ends right after the tool result.
function oneToolCallModel(id: string, name: string, args: unknown): MockLanguageModelV1 {
  let call = 0;
  return new MockLanguageModelV1({
    doStream: async () => {
      call += 1;
      const chunks = call === 1 ? toolCallRound(id, name, args) : textRound("done");
      return {
        stream: convertArrayToReadableStream(chunks),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  });
}

describe("loop agentId plumbing", () => {
  it("a loop with a subagent agentId cannot kill a root task; a root loop can", async () => {
    const rootTask = defaultTaskManager.start({ command: SLEEPER, cwd });

    const subLoop = makeLoop(oneToolCallModel("c1", "task_kill", { id: rootTask.id }), {
      agentId: "agent-11",
    });
    const subEvents = await collect(subLoop.stream("kill it", new AbortController().signal));
    const denied = subEvents.find((e) => e.type === "tool-result" && e.name === "task_kill");
    expect(denied).toMatchObject({ isError: true });
    if (denied?.type === "tool-result") {
      expect(denied.content).toContain("Unknown task");
    }
    expect(defaultTaskManager.get(rootTask.id)?.status).toBe("running");

    const rootLoop = makeLoop(oneToolCallModel("c1", "task_kill", { id: rootTask.id }));
    const rootEvents = await collect(rootLoop.stream("kill it", new AbortController().signal));
    const allowed = rootEvents.find((e) => e.type === "tool-result" && e.name === "task_kill");
    expect(allowed).toBeDefined();
    if (allowed?.type === "tool-result") {
      expect(allowed.isError).toBeFalsy();
      expect(allowed.content).toContain("stopped");
    }
  }, 20000);

  it("a background subagent owns its shell tasks under its agent task id", async () => {
    // Unique marker: finished task records persist in the shared manager
    // across tests, so a bare repeat of the sleeper command would find an
    // older, root-owned record.
    const childBash = 'node -e "setTimeout(() => {}, 30000) // bg-child-marker"';
    const loop = makeLoop(
      routingModel(
        [
          toolCallRound("c1", "subagent", { prompt: "bg child", run_in_background: true }),
          textRound("spawned"),
          textRound("spawned"),
        ],
        [
          toolCallRound("cc1", "bash", { command: childBash, run_in_background: true }),
          textRound("child done"),
        ],
      ),
    );

    const events = await collect(loop.stream("spawn bg child", new AbortController().signal));
    const spawned = events.find((e) => e.type === "tool-result" && e.name === "subagent");
    if (spawned?.type !== "tool-result") throw new Error("subagent tool result missing");
    const agentId = spawned.content.match(/Background subagent (agent-\d+)/)?.[1] as string;
    expect(agentId).toMatch(/^agent-\d+$/);

    await waitForNoRunningAgents();
    expect(defaultAgentTasks.runningCount()).toBe(0);

    const childTask = defaultTaskManager.list().find((t) => t.command === childBash);
    expect(childTask).toBeDefined();
    // The child loop's agentId is its own background task id.
    expect(childTask?.ownerId).toBe(agentId);
  }, 20000);

  it("a foreground subagent owns its shell tasks under a throwaway id", async () => {
    const childBash = 'node -e "setTimeout(() => {}, 30000) // fg-child-marker"';
    const loop = makeLoop(
      routingModel(
        [toolCallRound("c1", "subagent", { prompt: "fg child" }), textRound("parent done")],
        [
          toolCallRound("cc1", "bash", { command: childBash, run_in_background: true }),
          textRound("child done"),
        ],
      ),
    );

    await collect(loop.stream("spawn fg child", new AbortController().signal));

    const childTask = defaultTaskManager.list().find((t) => t.command === childBash);
    expect(childTask).toBeDefined();
    expect(childTask?.ownerId).toMatch(/^subagent-/);
  }, 20000);
});
