import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1 } from "ai/test";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/loop";
import type { ChatBackend } from "../src/cli/backend";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import type { ChatInput, CoreMessage } from "../src/core/messages";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import type { Tool } from "../src/tools/types";
import { renderApp, stripAnsi, tick, typeText } from "./ink-harness";

process.env.STAR_NO_UPDATE_CHECK = "1";
const { Repl } = await import("../src/cli/repl");

// Lone ESC keypress, written without a backslash escape.
const ESC = String.fromCharCode(27);

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | {
      type: "tool-call";
      toolCallType: "function";
      toolCallId: string;
      toolName: string;
      args: string;
    };

// Streams the given chunks, then hangs: the only way out is the abort signal,
// which surfaces as a stream error part exactly like a real cut connection
// (streamChat suppresses it as a user-initiated abort).
function hangingModel(chunks: Chunk[]): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async (options) => ({
      stream: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
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
    }),
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
    notifyBell: false,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [] },
    hooks: [],
    ...overrides,
  };
}

function danglingToolCallIds(messages: readonly CoreMessage[]): string[] {
  const pending = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call") pending.add(part.toolCallId);
      }
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        pending.delete(part.toolCallId);
      }
    }
  }
  return [...pending];
}

// Collects a loop stream, aborting as soon as an event of `abortOn` arrives.
async function collectWithAbort(
  loop: AgentLoop,
  input: string,
  abortOn: StreamEvent["type"],
): Promise<StreamEvent[]> {
  const controller = new AbortController();
  const events: StreamEvent[] = [];
  for await (const event of loop.stream(input, controller.signal)) {
    events.push(event);
    if (event.type === abortOn) controller.abort();
  }
  return events;
}

describe("AgentLoop interrupt persistence", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-interrupt-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-interrupt-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("keeps the partial reply in history and the session store on abort", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: hangingModel([{ type: "text-delta", textDelta: "partial answer" }]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    const events = await collectWithAbort(loop, "hi", "text-delta");

    expect(events).toEqual([{ type: "text-delta", text: "partial answer" }]);
    const expected: CoreMessage = {
      role: "assistant",
      content: [{ type: "text", text: "partial answer [interrupted]" }],
    };
    expect(loop.getMessages().at(-1)).toEqual(expected);
    expect((await store.messages()).at(-1)).toEqual(expected);
    expect(danglingToolCallIds(loop.getMessages())).toEqual([]);
  });

  it("persists nothing when aborted before any output", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: hangingModel([]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const events: StreamEvent[] = [];
    for await (const event of loop.stream("hi", controller.signal)) {
      events.push(event);
    }

    expect(events).toEqual([]);
    expect(loop.getMessages().every((m) => m.role !== "assistant")).toBe(true);
    expect((await store.messages()).every((m) => m.role !== "assistant")).toBe(true);
  });

  it("closes streamed tool calls with synthetic results when aborted before execution", async () => {
    let executed = false;
    const spyTool: Tool = {
      name: "spy_tool",
      description: "must never run",
      parameters: z.object({}),
      permission: "read",
      execute: async () => {
        executed = true;
        return { content: "ran" };
      },
    };
    const registry = createDefaultRegistry();
    registry.register(spyTool);
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: hangingModel([
        {
          type: "tool-call",
          toolCallType: "function",
          toolCallId: "c1",
          toolName: "spy_tool",
          args: "{}",
        },
      ]),
      registry,
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    const events = await collectWithAbort(loop, "hi", "tool-call");

    expect(executed).toBe(false);
    const synthetic = events.find((e) => e.type === "tool-result");
    expect(synthetic).toMatchObject({ id: "c1", isError: true });
    if (synthetic?.type === "tool-result") {
      expect(synthetic.content).toContain("interrupted by user");
    }
    expect(danglingToolCallIds(loop.getMessages())).toEqual([]);
    expect(danglingToolCallIds(await store.messages())).toEqual([]);
    const assistant = loop.getMessages().find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c1", toolName: "spy_tool" }],
    });
  });
});

describe("REPL interrupt display", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-interrupt-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-interrupt-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it(
    "keeps the partial reply on screen with an [interrupted] marker after Esc",
    { timeout: 30_000 },
    async () => {
      const backend: ChatBackend = {
        async *stream(_input: ChatInput, signal: AbortSignal): AsyncGenerator<StreamEvent> {
          yield { type: "text-delta", text: "partial reply" };
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      };
      const app = renderApp(
        createElement(Repl, {
          backend,
          model: "test",
          permissionMode: "auto",
          config: makeConfig(),
          cwd,
          sessionStore: null,
        }),
      );
      await tick();
      await typeText(app.stdin, "hello", "\r");
      await vi.waitFor(
        () => {
          expect(stripAnsi(app.lastFrame() ?? "")).toContain("partial reply");
        },
        { timeout: 15_000 },
      );
      app.stdin.write(ESC);
      await vi.waitFor(
        () => {
          const frame = stripAnsi(app.lastFrame() ?? "");
          expect(frame).toContain("partial reply");
          expect(frame).toContain("[interrupted]");
        },
        { timeout: 15_000 },
      );
      app.unmount();
    },
  );
});
