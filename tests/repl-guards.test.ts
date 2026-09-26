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
import type { ChatInput } from "../src/core/messages";
import type { PermissionRequest } from "../src/permissions/types";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

process.env.STAR_NO_UPDATE_CHECK = "1";
const { Repl, BUSY_BLOCKED_COMMANDS } = await import("../src/cli/repl");

const ESC = String.fromCharCode(27);

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
    permissions: { allow: [], deny: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: true,
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

  afterEach(() => {
    vi.unstubAllEnvs();
    defaultAgentTasks.cleanup();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("lists /redo among the busy-blocked commands", () => {
    expect(BUSY_BLOCKED_COMMANDS.has("redo")).toBe(true);
    expect(BUSY_BLOCKED_COMMANDS.has("undo")).toBe(true);
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
          expect(stripAnsi(app.lastFrame() ?? "")).toContain(
            "Busy — wait for the turn to finish or press Esc to interrupt it.",
          );
        },
        { timeout: 15_000 },
      );
      // Read-only commands still run while the turn is busy.
      await typeText(app.stdin, "/cost", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("API usage this session");
        },
        { timeout: 15_000 },
      );
      // /new never ran: no "Started a new session" message.
      expect(stripAnsi(app.lastFrame() ?? "")).not.toContain("Started a new session");
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
      expect(frame).toContain("Request failed, retrying (2/4)");
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

  it("warns about still-running background tasks on exit", { timeout: 30_000 }, async () => {
    const backend: ChatBackend = {
      async *stream(): AsyncGenerator<StreamEvent> {},
    };
    const app = renderRepl(backend, cwd);
    await tick();
    defaultAgentTasks.start(() => new Promise<string>(() => {}), { prompt: "never ends" });
    await tick();
    app.stdin.write("\x04"); // Ctrl+D
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.allOutput())).toContain(
          "1 background task(s) still running; reports will be lost.",
        );
      },
      { timeout: 15_000 },
    );
    app.unmount();
  });

  it("rebinds persistence to the resumed session on /resume", { timeout: 30_000 }, async () => {
    const oldStore = await SessionStore.create(cwd, "test");
    const targetStore = await SessionStore.create(cwd, "test");
    await targetStore.append({ role: "user", content: "from target session" });
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
    await typeText(app.stdin, "hello", "\r");
    await vi.waitFor(
      () => {
        expect(stripAnsi(app.lastFrame() ?? "")).toContain("pong");
      },
      { timeout: 15_000 },
    );
    // The new turn must land in the resumed session, not the previous one.
    await vi.waitFor(async () => {
      const targetMessages = await targetStore.messages();
      expect(targetMessages.some((m) => m.role === "user" && coreMessageText(m) === "hello")).toBe(
        true,
      );
    });
    const oldMessages = await oldStore.messages();
    expect(oldMessages.some((m) => coreMessageText(m) === "hello")).toBe(false);
    app.unmount();
  });
});
