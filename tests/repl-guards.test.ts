import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentTasks } from "../src/agent/agent-tasks";
import { AgentLoop } from "../src/agent/loop";
import type { ChatBackend } from "../src/cli/backend";
import { coreMessageText } from "../src/cli/format";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import type { ChatInput, CoreMessage } from "../src/core/messages";
import type { PermissionRequest } from "../src/permissions/types";
import { SessionStore } from "../src/session/store";
import { type TaskSnapshot, defaultTaskManager } from "../src/tasks/manager";
import { createDefaultRegistry } from "../src/tools";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";
import { rmWithRetry } from "./test-fs";

process.env.STAR_NO_UPDATE_CHECK = "1";
const { Repl, BUSY_BLOCKED_COMMANDS, REPL_RENDER_OPTIONS } = await import("../src/cli/repl");

const ESC = String.fromCharCode(27);
const SHIFT_TAB = `${ESC}[Z`;

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
    notifyBell: false,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: true,
    elisionThresholdFraction: 0.5,
    elisionKeepRecentMessages: 24,
    elisionMinTokens: 250,
    webFetchAllowPrivateHosts: false,
    ...overrides,
  };
}

function renderRepl(backend: ChatBackend, cwd: string, sessionStore: SessionStore | null = null) {
  return renderApp(
    createElement(Repl, {
      backend,
      model: "test",
      permissionMode: "auto",
      config: makeConfig(),
      cwd,
      sessionStore,
    }),
  );
}

// Streams the given events, then hangs until the abort signal fires.
function streamingBackend(events: StreamEvent[]): ChatBackend {
  return {
    async *stream(_input: ChatInput, signal: AbortSignal): AsyncGenerator<StreamEvent> {
      for (const event of events) yield event;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  };
}

describe("REPL turn guards", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-guards-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-guards-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await defaultAgentTasks.cleanup();
    await defaultTaskManager.cleanup();
    defaultAgentTasks.ackNotifications(
      defaultAgentTasks.peekNotifications().map((task) => task.id),
    );
    defaultTaskManager.ackNotifications(
      defaultTaskManager.peekNotifications().map((task) => task.id),
    );
    for (const dir of [cwd, home]) await rmWithRetry(dir);
  });

  it("lists /redo among the busy-blocked commands", () => {
    expect(BUSY_BLOCKED_COMMANDS.has("redo")).toBe(true);
    expect(BUSY_BLOCKED_COMMANDS.has("undo")).toBe(true);
  });

  it("opts Ink out of exit-on-Ctrl-C so the app owns Ctrl+C", () => {
    // Ink's default (true) would kill the process on \x03 and make the
    // InputBox Ctrl+C branch (interrupt the turn / clear the draft) dead
    // code; the harness mirrors this production value.
    expect(REPL_RENDER_OPTIONS).toEqual({ exitOnCtrlC: false });
  });

  it(
    "blocks destructive slash commands while a turn is streaming",
    { timeout: 30_000 },
    async () => {
      const backend = streamingBackend([{ type: "text-delta", text: "working" }]);
      const app = renderRepl(backend, cwd);
      await tick();
      await typeText(app.stdin, "hello", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("working");
        },
        { timeout: 15_000 },
      );
      await typeText(app.stdin, "/new", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.allOutput())).toContain(
            "Busy — wait for the turn to finish or press Esc to interrupt it.",
          );
        },
        { timeout: 15_000 },
      );
      // Read-only commands still run while the turn is busy.
      await typeText(app.stdin, "/cost", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.allOutput())).toContain("API usage this session");
        },
        { timeout: 15_000 },
      );
      // /new never ran: no "Started a new session" message.
      expect(stripAnsi(app.allOutput())).not.toContain("Started a new session");
      app.stdin.write(ESC);
      await tick();
      app.unmount();
    },
  );

  it(
    "rolls back the uncommitted stream text when a retry event arrives",
    { timeout: 30_000 },
    async () => {
      const backend: ChatBackend = {
        async *stream(): AsyncGenerator<StreamEvent> {
          yield { type: "text-delta", text: "Hello wo" };
          await new Promise((resolve) => setTimeout(resolve, 150));
          yield {
            type: "retry",
            attempt: 2,
            maxAttempts: 4,
            delayMs: 10,
            reason: "connection reset",
          };
          yield { type: "text-delta", text: "Hello world" };
          yield { type: "finish", finishReason: "stop" };
        },
      };
      const app = renderRepl(backend, cwd);
      await tick();
      await typeText(app.stdin, "hi", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("Hello world");
        },
        { timeout: 15_000 },
      );
      const frame = stripAnsi(app.lastFrame() ?? "");
      expect(frame).not.toContain("Hello woHello world");
      expect(frame.match(/Hello world/g)).toHaveLength(1);
      expect(stripAnsi(app.allOutput())).toContain("Request failed, retrying (2/4)");
      app.unmount();
    },
  );

  it(
    "serializes concurrent permission prompts instead of overwriting them",
    { timeout: 30_000 },
    async () => {
      const backend: ChatBackend = {
        async *stream(): AsyncGenerator<StreamEvent> {},
      };
      const app = renderRepl(backend, cwd);
      await tick();
      const handler = backend.confirmHandler;
      if (!handler) throw new Error("confirmHandler was not attached");
      const reqA: PermissionRequest = {
        toolName: "bash",
        args: { command: "echo first-command" },
        level: "exec",
      };
      const reqB: PermissionRequest = {
        toolName: "bash",
        args: { command: "echo second-command" },
        level: "exec",
      };
      const pA = handler(reqA);
      const pB = handler(reqB);
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("first-command");
        },
        { timeout: 15_000 },
      );
      // The second request waits behind the open prompt.
      expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("second-command");
      app.stdin.write("y");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("second-command");
        },
        { timeout: 15_000 },
      );
      await expect(pA).resolves.toBe(true);
      app.stdin.write("n");
      await expect(pB).resolves.toBe(false);
      app.unmount();
    },
  );

  it("aborts a queued permission without clearing another request's prompt", async () => {
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {},
    };
    const app = renderRepl(backend, cwd);
    await tick();
    const handler = backend.confirmHandler;
    if (!handler) throw new Error("confirmHandler was not attached");
    const reqA: PermissionRequest = {
      toolName: "bash",
      args: { command: "echo active-command" },
      level: "exec",
    };
    const controller = new AbortController();
    const reqB: PermissionRequest = {
      toolName: "bash",
      args: { command: "echo queued-command" },
      level: "exec",
      signal: controller.signal,
    };
    const pA = handler(reqA);
    const pB = handler(reqB);
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("active-command"));

    controller.abort();
    await expect(pB).resolves.toBe(false);
    expect(stripAnsi(app.lastFrame() ?? "")).toContain("active-command");
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("queued-command");
    app.stdin.write("y");
    await expect(pA).resolves.toBe(true);
    app.unmount();
  });

  it("stops background tasks and flushes before exit", { timeout: 30_000 }, async () => {
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {},
    };
    const app = renderRepl(backend, cwd);
    await tick();
    const handler = backend.confirmHandler;
    if (!handler) throw new Error("confirmHandler was not attached");
    const agent = defaultAgentTasks.start(
      async (signal) => {
        await handler({
          toolName: "bash",
          args: { command: "echo background-permission" },
          level: "exec",
          agentId: "agent-background",
          signal,
        });
        return "permission settled";
      },
      { prompt: "waits for permission" },
    );
    await vi.waitFor(() =>
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("background-permission"),
    );
    app.stdin.write("\x04"); // Ctrl+D
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.allOutput())).toContain(
          "Stopped 1 background task(s) and flushed their reports before exit.",
        );
      },
      { timeout: 15_000 },
    );
    expect(defaultAgentTasks.get(agent.id)?.status).toBe("stopped");
    expect(stripAnsi(app.allOutput())).not.toContain("reports will be lost");
    app.unmount();
  });

  it("cancels exit when background reports cannot be flushed and allows a retry", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: store,
    });
    const flush = vi
      .spyOn(loop, "flushBackgroundNotifications")
      .mockRejectedValueOnce(new Error("store is full"));
    const close = vi.spyOn(store, "close");
    const app = renderRepl(loop, cwd, store);
    await tick();

    app.stdin.write("\x04");
    await vi.waitFor(() => {
      expect(stripAnsi(app.allOutput())).toContain(
        "Exit cancelled because background work could not be stopped or its reports could not be saved",
      );
    });
    expect(close).not.toHaveBeenCalled();

    await typeText(app.stdin, "/cost", "\r");
    await vi.waitFor(() =>
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("API usage this session: 0 requests"),
    );
    await typeText(app.stdin, "/exit", "\r");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(2);
    app.unmount();
  });

  it("flushes reports and cancels exit when cleanup returns stop_failed", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: store,
    });
    const stopFailed: TaskSnapshot = {
      id: "task-unconfirmed",
      notificationId: "test:task-unconfirmed",
      ownerId: "root",
      command: "sleep",
      status: "stop_failed",
      stopError: "process state is unconfirmed",
      startedAt: Date.now(),
      output: "",
      outputStart: 0,
      nextOffset: 0,
    };
    vi.spyOn(defaultTaskManager, "cleanup").mockResolvedValue([stopFailed]);
    const flush = vi.spyOn(loop, "flushBackgroundNotifications").mockResolvedValue(0);
    const close = vi.spyOn(store, "close");
    const app = renderRepl(loop, cwd, store);

    app.stdin.write("\x04");
    await vi.waitFor(() => {
      const output = stripAnsi(app.allOutput());
      expect(output).toContain("Exit cancelled");
      expect(output).toContain("task-unconfirmed: process state is unconfirmed");
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(stripAnsi(app.allOutput())).not.toContain("Stopped 1 background task(s)");
    app.unmount();
    await store.close();
  });

  it.each(["new", "resume", "fork"])(
    "aborts /%s without rebinding when cleanup returns stop_failed",
    async (operation) => {
      const store = await SessionStore.create(cwd, "test");
      let command = `/${operation}`;
      let successMessage = "Started a new session";
      if (operation === "fork") {
        await store.append({ role: "user", content: "fork this" });
        successMessage = "Forked into new session";
      } else if (operation === "resume") {
        const target = await SessionStore.create(cwd, "test");
        await target.append({ role: "user", content: "resume this" });
        await target.close();
        command = `/resume ${target.id}`;
        successMessage = "Resumed session";
      }
      const loop = new AgentLoop({
        model: new MockLanguageModelV1(),
        registry: createDefaultRegistry(),
        config: makeConfig({ gitSnapshots: false }),
        cwd,
        sessionStore: store,
      });
      const stopFailed: TaskSnapshot = {
        id: "task-unconfirmed",
        notificationId: "test:task-unconfirmed",
        ownerId: "root",
        command: "sleep",
        status: "stop_failed",
        stopError: "process state is unconfirmed",
        startedAt: Date.now(),
        output: "",
        outputStart: 0,
        nextOffset: 0,
      };
      vi.spyOn(defaultTaskManager, "cleanup").mockResolvedValue([stopFailed]);
      const flush = vi.spyOn(loop, "flushBackgroundNotifications").mockResolvedValue(0);
      const rebind = vi.spyOn(loop, "setSessionStore");
      const app = renderRepl(loop, cwd, store);

      await typeText(app.stdin, command, "\r");
      await vi.waitFor(() => {
        const output = stripAnsi(app.allOutput());
        expect(output).toContain("Failed to stop background work;");
        expect(output).toContain("task-unconfirmed: process state is unconfirmed");
      });
      expect(flush).toHaveBeenCalledTimes(1);
      expect(rebind).not.toHaveBeenCalled();
      expect(stripAnsi(app.allOutput())).not.toContain(successMessage);
      app.unmount();
      await store.close();
    },
  );

  it("reloads the current session after flushing new reports on /resume", async () => {
    const oldStore = await SessionStore.create(cwd, "test");
    await oldStore.append({ role: "user", content: "existing history" });
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: oldStore,
    });
    const app = renderRepl(loop, cwd, oldStore);
    await tick();
    const agent = defaultAgentTasks.start(
      (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("finished during resume cleanup"), {
            once: true,
          });
        }),
      { prompt: "resume cleanup" },
    );

    await typeText(app.stdin, `/resume ${oldStore.id}`, "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain(`Resumed session ${oldStore.id}`);
      },
      { timeout: 15_000 },
    );

    const inMemory = loop.getStarMessages();
    const persisted = await oldStore.starMessages();
    for (const messages of [inMemory, persisted]) {
      expect(messages).toHaveLength(2);
      expect(
        messages.filter(
          (star) =>
            star.message.role === "user" && coreMessageText(star.message) === "existing history",
        ),
      ).toHaveLength(1);
      const reports = messages.filter((star) => star.meta?.notificationId === agent.notificationId);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.meta?.synthetic).toBe("bg-report");
      expect(coreMessageText(reports[0]?.message ?? { role: "user", content: "" })).toContain(
        `[background subagent ${agent.id} stopped]\nStopped on shutdown.`,
      );
    }
    app.unmount();
    await oldStore.close();
  });

  it("rebinds persistence to the resumed session on /resume", { timeout: 30_000 }, async () => {
    const oldStore = await SessionStore.create(cwd, "test");
    const targetStore = await SessionStore.create(cwd, "test");
    await targetStore.append({ role: "user", content: "from target session" });
    await targetStore.addUsage({ promptTokens: 11, completionTokens: 7, totalTokens: 18 });
    await targetStore.close();
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: "text-delta", textDelta: "pong" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 3 },
          },
        ]),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: oldStore,
    });
    const app = renderRepl(loop, cwd, oldStore);
    await tick();
    await typeText(app.stdin, `/resume ${targetStore.id}`, "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain(`Resumed session ${targetStore.id}`);
      },
      { timeout: 15_000 },
    );
    await typeText(app.stdin, "/cost", "\r");
    await vi.waitFor(() =>
      expect(stripAnsi(app.lastFrame() ?? "")).toContain(
        "API usage this session: 1 requests, 11 prompt + 7 completion = 18 tokens",
      ),
    );
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("pong");
      },
      { timeout: 15_000 },
    );
    // The new turn must land in the resumed session, not the previous one.
    // Slow CI disks (windows runners especially) can push the append past the
    // default 1s waitFor budget; give it the same allowance as the UI waits.
    await vi.waitFor(
      async () => {
        const targetMessages = await targetStore.messages();
        expect(
          targetMessages.some((m) => m.role === "user" && coreMessageText(m) === "hello"),
        ).toBe(true);
      },
      { timeout: 15_000 },
    );
    const oldMessages = await oldStore.messages();
    expect(oldMessages.some((m) => coreMessageText(m) === "hello")).toBe(false);
    app.unmount();
  });

  it(
    "queues prompts and refuses nested session commands while /compact runs",
    { timeout: 30_000 },
    async () => {
      const model = new MockLanguageModelV1({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "pong" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });
      const loop = new AgentLoop({
        model,
        registry: createDefaultRegistry(),
        config: makeConfig(),
        cwd,
      });
      const pad = (n: number) => "x".repeat(n);
      await loop.loadMessages([
        { role: "user", content: pad(400) },
        { role: "assistant", content: pad(400) },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ]);
      // Gate the loadMessages call that /compact ends with, so the in-flight
      // window stays open until this test releases it.
      const original = loop.loadMessages.bind(loop);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      loop.loadMessages = (async (messages: Parameters<AgentLoop["loadMessages"]>[0]) => {
        await gate;
        return original(messages);
      }) as AgentLoop["loadMessages"];

      const app = renderRepl(loop, cwd);
      await tick();
      await typeText(app.stdin, "/compact", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("compacting context…");
        },
        { timeout: 15_000 },
      );
      // A prompt typed mid-compact queues instead of starting a turn whose
      // messages the compaction's loadMessages would then clobber.
      await typeText(app.stdin, "hello", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("queued: hello");
        },
        { timeout: 15_000 },
      );
      // Nested /compact and other session-rewriting commands are refused.
      await typeText(app.stdin, "/compact", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.allOutput())).toContain("Busy — /compact is still running.");
        },
        { timeout: 15_000 },
      );
      await typeText(app.stdin, "/new", "\r");
      await tick();
      expect(stripAnsi(app.allOutput())).not.toContain("Started a new session");
      // Release the compaction: the rewrite lands, then the queued prompt runs.
      release();
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.allOutput())).toContain("Compacted context");
        },
        { timeout: 15_000 },
      );
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("pong");
        },
        { timeout: 15_000 },
      );
      app.unmount();
    },
  );

  it(
    "Esc cancels a running /compact instead of editing the last message",
    { timeout: 30_000 },
    async () => {
      let summaryCalls = 0;
      const model = new MockLanguageModelV1({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "pong" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
        doGenerate: async (options) => {
          summaryCalls += 1;
          if (summaryCalls === 1) {
            // The first compaction's summary hangs until the Esc abort cuts it.
            await new Promise<void>((resolve) => {
              if (options.abortSignal?.aborted) resolve();
              else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            });
            throw new Error("This operation was aborted");
          }
          return {
            text: "SUMMARY",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 3 },
            rawCall: { rawPrompt: null, rawSettings: {} },
          };
        },
      });
      const store = await SessionStore.create(cwd, "test");
      const loop = new AgentLoop({
        model,
        registry: createDefaultRegistry(),
        config: makeConfig(),
        cwd,
        sessionStore: store,
      });
      const pad = (n: number) => "x".repeat(n);
      const history: CoreMessage[] = [
        { role: "user", content: pad(400) },
        { role: "assistant", content: pad(400) },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ];
      await loop.loadMessages(history);
      for (const message of history) await store.append(message);

      const app = renderRepl(loop, cwd, store);
      await tick();
      await typeText(app.stdin, "/compact", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("compacting context…");
        },
        { timeout: 15_000 },
      );
      // Double-Esc during the busy command used to run editLastMessage: its
      // retraction raced the compaction rewrite and was resurrected by it.
      app.stdin.write(ESC);
      await tick();
      app.stdin.write(ESC);
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("Compaction cancelled");
        },
        { timeout: 15_000 },
      );
      expect(stripAnsi(app.allOutput())).not.toContain("restored for editing");
      // Cancelled before the rewrite: history and the persisted file are as-is.
      expect(loop.getMessages()).toEqual(history);
      expect(await store.messages()).toEqual(history);
      // A follow-up /compact is unaffected and completes normally.
      await typeText(app.stdin, "/compact", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("Compacted context");
        },
        { timeout: 15_000 },
      );
      app.unmount();
    },
  );

  it(
    "Shift+Tab does not cycle the permission mode while /compact runs",
    { timeout: 30_000 },
    async () => {
      const model = new MockLanguageModelV1({
        doGenerate: async (options) => {
          await new Promise<void>((resolve) => {
            if (options.abortSignal?.aborted) resolve();
            else options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new Error("This operation was aborted");
        },
      });
      const loop = new AgentLoop({
        model,
        registry: createDefaultRegistry(),
        config: makeConfig(),
        cwd,
      });
      const pad = (n: number) => "x".repeat(n);
      await loop.loadMessages([
        { role: "user", content: pad(400) },
        { role: "assistant", content: pad(400) },
        { role: "user", content: "u2" },
        { role: "assistant", content: "a2" },
        { role: "user", content: "u3" },
        { role: "assistant", content: "a3" },
      ]);
      const config = makeConfig();
      const app = renderApp(
        createElement(Repl, {
          backend: loop,
          model: "test",
          permissionMode: "auto",
          config,
          cwd,
          sessionStore: null,
        }),
      );
      await tick();
      await typeText(app.stdin, "/compact", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("compacting context…");
        },
        { timeout: 15_000 },
      );
      app.stdin.write(SHIFT_TAB);
      await tick();
      expect(config.permissionMode).toBe("auto");
      // Esc cancels the compaction; once the busy flag clears Shift+Tab cycles.
      app.stdin.write(ESC);
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("Compaction cancelled");
        },
        { timeout: 15_000 },
      );
      app.stdin.write(SHIFT_TAB);
      await tick();
      expect(config.permissionMode).toBe("readonly");
      app.unmount();
    },
  );

  it(
    "Esc cancels the mid-turn send picker without queueing or interrupting",
    { timeout: 30_000 },
    async () => {
      const model = new MockLanguageModelV1({
        doStream: async (options) => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-delta", textDelta: "working" });
              const cut = () => {
                try {
                  controller.enqueue({
                    type: "error",
                    error: new Error("This operation was aborted"),
                  });
                  controller.close();
                } catch {
                  // Already closed by a normal stream finish.
                }
              };
              if (options.abortSignal?.aborted) cut();
              else options.abortSignal?.addEventListener("abort", cut, { once: true });
            },
          }),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });
      const loop = new AgentLoop({
        model,
        registry: createDefaultRegistry(),
        config: makeConfig({ gitSnapshots: false }),
        cwd,
      });
      const app = renderRepl(loop, cwd);
      await typeText(app.stdin, "hello", "\r");
      await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("working"));
      await typeText(app.stdin, "follow up", "\r");
      await vi.waitFor(() => {
        const frame = stripAnsi(app.lastFrame() ?? "");
        expect(frame).toContain("Turn is running — how should this be sent?");
        expect(frame).toContain("insert into the running turn");
        expect(frame).toContain("queue for after the turn");
      });
      const pickerLines = stripAnsi(app.lastFrame() ?? "").split("\n");
      const inputRow = pickerLines.findIndex((line) => line.includes("│ ❯"));
      const pickerRow = pickerLines.findIndex((line) => line.includes("Turn is running"));
      const statusRow = pickerLines.findIndex((line) => line.includes("mode: auto"));
      expect(inputRow).toBeGreaterThanOrEqual(0);
      expect(pickerRow).toBeGreaterThan(inputRow);
      expect(statusRow).toBeGreaterThan(pickerRow);

      app.stdin.write(ESC);
      await vi.waitFor(() => {
        const frame = stripAnsi(app.lastFrame() ?? "");
        expect(frame).toContain("❯ follow up");
        expect(frame).not.toContain("Turn is running — how should this be sent?");
      });
      expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("queued: follow up");
      expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("[interrupted]");
      expect(loop.takeUndeliveredSteers()).toEqual([]);

      await typeText(app.stdin, "\r");
      await vi.waitFor(() =>
        expect(stripAnsi(app.lastFrame() ?? "")).toContain(
          "Turn is running — how should this be sent?",
        ),
      );
      await typeText(app.stdin, "\u001B[B", "\r");
      await vi.waitFor(() =>
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("queued: follow up"),
      );
      app.stdin.write(ESC);
      await tick();
      app.unmount();
    },
  );

  it("Esc closes a picker without interrupting the running turn", { timeout: 30_000 }, async () => {
    const backend = streamingBackend([{ type: "text-delta", text: "working" }]);
    const app = renderRepl(backend, cwd);
    await tick();
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("working");
      },
      { timeout: 15_000 },
    );
    // /permission is not busy-blocked: its picker opens mid-turn.
    await typeText(app.stdin, "/permission", "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("Select a permission mode");
      },
      { timeout: 15_000 },
    );
    // Esc goes to the picker alone: it cancels, the turn keeps streaming.
    app.stdin.write(ESC);
    await vi.waitFor(
      () => {
        const frame = stripAnsi(app.lastFrame() ?? "");
        expect(frame).toContain("Permission mode unchanged");
        expect(frame).not.toContain("[interrupted]");
      },
      { timeout: 15_000 },
    );
    // With the popup gone, Esc interrupts the turn as before.
    app.stdin.write(ESC);
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("[interrupted]");
      },
      { timeout: 15_000 },
    );
    app.unmount();
  });

  it("releases queued background permissions on Ctrl+D without user decisions", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: store,
    });
    const app = renderRepl(loop, cwd, store);
    await tick();
    const handler = loop.confirmHandler;
    if (!handler) throw new Error("confirmHandler was not attached");
    const agents = ["first-background", "second-background"].map((command) =>
      defaultAgentTasks.start(
        async (signal) => {
          await handler({
            toolName: "bash",
            args: { command },
            level: "exec",
            agentId: "agent-background",
            signal,
          });
          return "permission settled";
        },
        { prompt: command },
      ),
    );
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("first-background"));
    expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("second-background");

    app.stdin.write("\x04");
    await vi.waitFor(
      () => expect(stripAnsi(app.allOutput())).toContain("Stopped 2 background task(s)"),
      { timeout: 15_000 },
    );
    expect(agents.map((agent) => defaultAgentTasks.get(agent.id)?.status)).toEqual([
      "stopped",
      "stopped",
    ]);
    app.unmount();
  });

  it(
    "waits for background cleanup on /new and keeps old reports and usage out of the new session",
    { timeout: 30_000 },
    async () => {
      const model = new MockLanguageModelV1({
        doStream: async () => ({
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "pong" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        }),
      });
      const store = await SessionStore.create(cwd, "test");
      const loop = new AgentLoop({
        model,
        registry: createDefaultRegistry(),
        config: makeConfig(),
        cwd,
        sessionStore: store,
      });
      const app = renderRepl(loop, cwd, store);
      await tick();
      let settle = (_result: string) => {};
      const agentResult = new Promise<string>((resolve) => {
        settle = resolve;
      });
      const agent = defaultAgentTasks.start(() => agentResult, { prompt: "old session work" });
      await typeText(app.stdin, "/new", "\r");
      await vi.waitFor(() => expect(defaultAgentTasks.get(agent.id)?.status).toBe("stopping"));
      expect(stripAnsi(app.allOutput())).not.toContain("Started a new session");

      settle("finished after cancellation");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("Started a new session");
        },
        { timeout: 15_000 },
      );
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("Stopped 1 background task(s)");
      const oldMessages = await store.starMessages();
      expect(
        oldMessages.some(
          (star) =>
            star.message.role === "user" &&
            coreMessageText(star.message).includes(`background subagent ${agent.id} stopped`),
        ),
      ).toBe(true);
      expect(
        loop
          .getMessages()
          .some((m) => m.role === "user" && coreMessageText(m).includes("background subagent")),
      ).toBe(false);

      loop.onUsage?.(
        { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
        "test",
        0,
        store.id,
      );
      await typeText(app.stdin, "/cost", "\r");
      await vi.waitFor(() =>
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("API usage this session: 0 requests"),
      );
      loop.onUsage?.({ promptTokens: 2, completionTokens: 1, totalTokens: 3 }, "test", 0);
      await typeText(app.stdin, "/cost", "\r");
      await vi.waitFor(() =>
        expect(stripAnsi(app.lastFrame() ?? "")).toContain(
          "API usage this session: 1 requests, 2 prompt + 1 completion = 3 tokens",
        ),
      );

      await typeText(app.stdin, "hello", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("pong");
        },
        { timeout: 15_000 },
      );
      expect(
        loop
          .getMessages()
          .some((m) => m.role === "user" && coreMessageText(m).includes("background subagent")),
      ).toBe(false);
      app.unmount();
    },
  );

  it("aborts /new without rebinding when old background reports cannot be flushed", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: store,
    });
    vi.spyOn(loop, "flushBackgroundNotifications").mockRejectedValue(new Error("store is full"));
    const rebind = vi.spyOn(loop, "setSessionStore");
    const app = renderRepl(loop, cwd, store);
    await typeText(app.stdin, "/new", "\r");

    await vi.waitFor(() => {
      const frame = stripAnsi(app.lastFrame() ?? "");
      expect(frame).toContain("new session was not created and the current session is unchanged:");
      expect(frame).toContain("store is full");
    });
    expect(rebind).not.toHaveBeenCalled();
    expect(stripAnsi(app.allOutput())).not.toContain("Started a new session");
    app.unmount();
  });

  it("closes an opened resume target when stopping the old session fails", async () => {
    const oldStore = await SessionStore.create(cwd, "test");
    const target = await SessionStore.create(cwd, "test");
    await target.append({ role: "user", content: "target history" });
    await target.close();
    const loop = new AgentLoop({
      model: new MockLanguageModelV1(),
      registry: createDefaultRegistry(),
      config: makeConfig({ gitSnapshots: false }),
      cwd,
      sessionStore: oldStore,
    });
    vi.spyOn(loop, "flushBackgroundNotifications").mockRejectedValue(new Error("flush failed"));
    const rebind = vi.spyOn(loop, "setSessionStore");
    const app = renderRepl(loop, cwd, oldStore);
    await typeText(app.stdin, `/resume ${target.id}`, "\r");

    await vi.waitFor(() => {
      expect(stripAnsi(app.lastFrame() ?? "")).toContain(
        "resume aborted and the current session is unchanged: flush failed",
      );
    });
    expect(rebind).not.toHaveBeenCalled();
    const reopened = await SessionStore.open(target.id);
    expect(reopened).not.toBeNull();
    await reopened?.close();
    app.unmount();
  });

  it("forks from the pre-cleanup snapshot and resets usage and budget state", async () => {
    let request = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        const text = request++ === 0 ? "before response" : "after response";
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: text },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const store = await SessionStore.create(cwd, "test");
    const config = makeConfig({
      gitSnapshots: false,
      sessionBudgetUsd: 1.5,
      models: [
        {
          name: "test",
          provider: "test",
          model: "test",
          promptPrice: 1_000_000,
          completionPrice: 1_000_000,
        },
      ],
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config,
      cwd,
      sessionStore: store,
      modelName: "test",
    });
    const app = renderApp(
      createElement(Repl, {
        backend: loop,
        model: "test",
        permissionMode: "auto",
        config,
        cwd,
        sessionStore: store,
        initialUsage: {
          requests: 1,
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          costUsd: 0,
        },
      }),
    );
    await typeText(app.stdin, "before fork", "\r");
    await vi.waitFor(() => {
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("before response");
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("Session budget exceeded");
    });

    let settle = (_result: string) => {};
    const agentResult = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const agent = defaultAgentTasks.start(() => agentResult, { prompt: "fork cleanup" });
    await typeText(app.stdin, "/fork", "\r");
    await vi.waitFor(() => expect(defaultAgentTasks.get(agent.id)?.status).toBe("stopping"));
    expect(stripAnsi(app.allOutput())).not.toContain("Forked into new session");
    settle("cancelled result");

    await vi.waitFor(
      () => expect(stripAnsi(app.lastFrame() ?? "")).toContain("Forked into new session"),
      { timeout: 15_000 },
    );
    expect(
      (await store.starMessages()).some(
        (star) =>
          star.message.role === "user" &&
          coreMessageText(star.message).includes(`background subagent ${agent.id} stopped`),
      ),
    ).toBe(true);
    expect(
      loop
        .getMessages()
        .some((message) => coreMessageText(message).includes("background subagent")),
    ).toBe(false);

    await typeText(app.stdin, "/cost", "\r");
    await vi.waitFor(() =>
      expect(stripAnsi(app.lastFrame() ?? "")).toContain("API usage this session: 0 requests"),
    );
    await typeText(app.stdin, "after fork", "\r");
    await vi.waitFor(() => expect(stripAnsi(app.lastFrame() ?? "")).toContain("after response"), {
      timeout: 15_000,
    });
    app.unmount();
  });
});
