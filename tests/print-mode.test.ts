import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentTasks } from "../src/agent/agent-tasks";
import { AgentLoop } from "../src/agent/loop";
import { printMode } from "../src/cli/print-mode";
import { ConfigSchema } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { type TaskSnapshot, defaultTaskManager } from "../src/tasks/manager";
import { createDefaultRegistry } from "../src/tools";

function config() {
  return ConfigSchema.parse({
    defaultModel: "test",
    models: [],
    providers: [],
    permissionMode: "auto",
    streamMaxRetries: 1,
    gitSnapshots: false,
  });
}

function textRound(text: string) {
  return [
    { type: "text-delta", textDelta: text },
    {
      type: "finish",
      finishReason: "stop",
      usage: { promptTokens: 5, completionTokens: 3 },
    },
  ];
}

function toolCallRound(name: string, args: unknown) {
  return [
    {
      type: "tool-call",
      toolCallType: "function",
      toolCallId: "call-1",
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

describe("production printMode", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-print-mode-"));
  });

  afterEach(async () => {
    await Promise.all([defaultTaskManager.cleanup(), defaultAgentTasks.cleanup()]);
    defaultTaskManager.ackNotifications(
      defaultTaskManager.peekNotifications().map((task) => task.id),
    );
    defaultAgentTasks.ackNotifications(
      defaultAgentTasks.peekNotifications().map((task) => task.id),
    );
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  });

  it("drops failed-attempt output instead of duplicating it after a retry", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call += 1;
        return {
          stream: convertArrayToReadableStream(
            call === 1
              ? [
                  { type: "text-delta", textDelta: "failed draft" },
                  {
                    type: "error",
                    error: Object.assign(new Error("offline"), { code: "ECONNRESET" }),
                  },
                ]
              : ([
                  { type: "text-delta", textDelta: "committed" },
                  {
                    type: "finish",
                    finishReason: "stop",
                    usage: { promptTokens: 1, completionTokens: 1 },
                  },
                ] as never),
          ),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: config(),
      cwd,
      retryDelayMs: 1,
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(loop, "hi", cwd, false, [], null)).toBe(0);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toBe("committed\n");
    expect(output).not.toContain("failed draft");
  });

  it("disables background bash without starting a task", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream(
          (call++ === 0
            ? toolCallRound("bash", { command: "sleep 1", run_in_background: true })
            : textRound("foreground instead")) as never,
        ),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: config(),
      cwd,
      allowBackgroundTasks: false,
    });
    const start = vi.spyOn(defaultTaskManager, "start");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(loop, "run", cwd, false, [], null)).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      "Background tasks are disabled in print mode",
    );
  });

  it("disables background subagents without starting a task", async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream(
          (call++ === 0
            ? toolCallRound("subagent", { prompt: "work", run_in_background: true })
            : textRound("foreground instead")) as never,
        ),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: config(),
      cwd,
      allowBackgroundTasks: false,
    });
    const start = vi.spyOn(defaultAgentTasks, "start");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(loop, "run", cwd, false, [], null)).toBe(0);
    expect(start).not.toHaveBeenCalled();
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      "Background subagents are disabled in print mode",
    );
  });

  it("includes usage settled during cleanup in the final JSON usage line", async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream(textRound("parent") as never),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: config(),
      cwd,
    });
    const background = defaultAgentTasks.start(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              loop.onUsage?.(
                { promptTokens: 7, completionTokens: 2, totalTokens: 9 },
                "child",
                null,
              );
              resolve("late report");
            },
            { once: true },
          );
        }),
      { prompt: "late usage" },
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(loop, "run", cwd, true, [], null)).toBe(0);
    const lines = stdout.mock.calls.map(([chunk]) => String(chunk).trim()).filter(Boolean);
    const usage = JSON.parse(lines.at(-1) ?? "{}");
    expect(usage).toMatchObject({
      type: "usage",
      requests: 2,
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
    });
    expect(lines.join("\n")).not.toContain("Stopped on shutdown");
    expect(
      loop
        .getStarMessages()
        .some((star) => star.meta?.notificationId === background.notificationId),
    ).toBe(true);
  });

  it("returns nonzero for a notification persistence failure without polluting JSON stdout", async () => {
    const backend = {
      onUsage: undefined,
      onHookWarning: undefined,
      async *stream(): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "answer" };
      },
      async flushBackgroundNotifications(): Promise<number> {
        throw new Error("persist failed");
      },
    } as unknown as AgentLoop;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(backend, "hi", cwd, true, [], null)).toBe(1);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain(
      "persist failed",
    );
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain("persist failed");
  });

  it("counts only confirmed stops and returns nonzero for stop_failed cleanup", async () => {
    const backend = {
      onUsage: undefined,
      onHookWarning: undefined,
      async *stream(): AsyncGenerator<StreamEvent> {},
      async flushBackgroundNotifications(): Promise<number> {
        return 0;
      },
    } as unknown as AgentLoop;
    const base: TaskSnapshot = {
      id: "task-stopped",
      notificationId: "test:task-stopped",
      ownerId: "root",
      command: "sleep",
      status: "stopped",
      startedAt: Date.now(),
      output: "",
      outputStart: 0,
      nextOffset: 0,
    };
    vi.spyOn(defaultTaskManager, "cleanup").mockResolvedValue([
      base,
      {
        ...base,
        id: "task-unconfirmed",
        status: "stop_failed",
        stopError: "process state is unconfirmed",
      },
    ]);
    vi.spyOn(defaultAgentTasks, "cleanup").mockResolvedValue([]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(await printMode(backend, "hi", cwd, false, [], null)).toBe(1);
    const errors = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(errors).toContain(
      "[info] 1 background task(s) were still running and have been stopped.",
    );
    expect(errors).not.toContain("[info] 2 background task(s)");
    expect(errors).toContain("task-unconfirmed: process state is unconfirmed");
  });

  it("returns 130 on SIGINT and flushes the partial response", async () => {
    const backend = {
      onUsage: undefined,
      onHookWarning: undefined,
      async *stream(_input: unknown, signal: AbortSignal): AsyncGenerator<StreamEvent> {
        yield { type: "text-delta", text: "partial" };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
      async flushBackgroundNotifications(): Promise<number> {
        throw new Error("persist failed");
      },
    } as unknown as AgentLoop;
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const running = printMode(backend, "hi", cwd, false, [], null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.emit("SIGINT");

    expect(await running).toBe(130);
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe("partial\n");
  });
});
