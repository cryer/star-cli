import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import {
  type CoreMessage,
  MISSING_TOOL_RESULT_TEXT,
  reconcileToolCalls,
} from "../src/core/messages";
import { resumeSession } from "../src/session/resume";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import type { Tool } from "../src/tools/types";

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

function toolCallChunk(id: string, name: string, args: unknown): Chunk {
  return {
    type: "tool-call",
    toolCallType: "function",
    toolCallId: id,
    toolName: name,
    args: JSON.stringify(args),
  };
}

function toolCallsRound(calls: [string, string, unknown][]): Chunk[] {
  return [
    ...calls.map(([id, name, args]) => toolCallChunk(id, name, args)),
    { type: "finish", finishReason: "tool-calls", usage: { promptTokens: 5, completionTokens: 3 } },
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
    notifyBell: true,
    notifyBellThresholdSec: 10,
    permissions: { allow: [] },
    hooks: [],
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

function assistantWithCalls(calls: [string, string][]): CoreMessage {
  return {
    role: "assistant",
    content: calls.map(([toolCallId, toolName]) => ({
      type: "tool-call" as const,
      toolCallId,
      toolName,
      args: {},
    })),
  };
}

describe("reconcileToolCalls", () => {
  it("passes a complete history through unchanged", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "hi" },
      assistantWithCalls([["c1", "read_file"]]),
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", result: "ok" }],
      },
      { role: "assistant", content: "done" },
    ];

    expect(reconcileToolCalls(messages)).toEqual(messages);
  });

  it("fills a synthetic result for a dangling tool call", () => {
    const messages: CoreMessage[] = [
      { role: "user", content: "hi" },
      assistantWithCalls([["c1", "bash"]]),
    ];

    const fixed = reconcileToolCalls(messages);

    expect(fixed).toHaveLength(3);
    expect(fixed[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "bash",
          result: MISSING_TOOL_RESULT_TEXT,
        },
      ],
    });
    expect(danglingToolCallIds(fixed)).toEqual([]);
  });

  it("fills only the missing results when a batch is partially answered", () => {
    const messages: CoreMessage[] = [
      assistantWithCalls([
        ["c1", "read_file"],
        ["c2", "bash"],
        ["c3", "grep"],
      ]),
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c2", toolName: "bash", result: "ok" }],
      },
      { role: "user", content: "next" },
    ];

    const fixed = reconcileToolCalls(messages);

    expect(fixed).toHaveLength(5);
    expect(fixed[0]).toEqual(messages[0]);
    expect(fixed[1]).toEqual(messages[1]);
    expect(fixed[2]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", result: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(fixed[3]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c3", result: MISSING_TOOL_RESULT_TEXT }],
    });
    expect(fixed[4]).toEqual(messages[2]);
    expect(danglingToolCallIds(fixed)).toEqual([]);
  });
});

describe("AgentLoop tool-call completion", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-reconcile-cwd-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-reconcile-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  function makeLoop(
    model: MockLanguageModelV1,
    configOverrides: Partial<StarConfig> = {},
    sessionStore?: SessionStore,
  ): AgentLoop {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(configOverrides),
      cwd,
      sessionStore,
    });
  }

  it("fills synthetic results for the remaining calls when aborted mid-batch", async () => {
    const controller = new AbortController();
    const abortingTool: Tool = {
      name: "aborting_tool",
      description: "aborts the run while executing",
      parameters: z.object({}),
      permission: "read",
      execute: async () => {
        controller.abort();
        return { content: "first tool done" };
      },
    };
    const registry = createDefaultRegistry();
    registry.register(abortingTool);
    const store = await SessionStore.create(cwd, "test");
    const loop = new AgentLoop({
      model: mockModel([
        toolCallsRound([
          ["c1", "aborting_tool", {}],
          ["c2", "todo_read", {}],
        ]),
        textRound("unreachable"),
      ]),
      registry,
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    const events = await collect(loop.stream("run both", controller.signal));

    const first = events.find((e) => e.type === "tool-result" && e.id === "c1");
    expect(first).toMatchObject({ content: "first tool done" });
    if (first?.type === "tool-result") {
      expect(first.isError).toBeFalsy();
    }
    const second = events.find((e) => e.type === "tool-result" && e.id === "c2");
    expect(second).toMatchObject({ isError: true });
    if (second?.type === "tool-result") {
      expect(second.content).toContain("interrupted by user");
    }

    expect(danglingToolCallIds(loop.getMessages())).toEqual([]);
    expect(danglingToolCallIds(await store.messages())).toEqual([]);
  });

  it("turns a throwing confirmHandler into a denied tool result", async () => {
    const store = await SessionStore.create(cwd, "test");
    const loop = makeLoop(
      mockModel([
        toolCallsRound([["c1", "write_file", { path: "nope.txt", content: "x" }]]),
        textRound("understood"),
      ]),
      { permissionMode: "ask" },
      store,
    );
    loop.confirmHandler = async () => {
      throw new Error("UI blew up");
    };

    const events = await collect(loop.stream("write", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ id: "c1", isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("User rejected");
    }
    expect(fs.existsSync(path.join(cwd, "nope.txt"))).toBe(false);
    expect(danglingToolCallIds(loop.getMessages())).toEqual([]);
    expect(danglingToolCallIds(await store.messages())).toEqual([]);
  });

  it("keeps persisted history complete when a later round fails mid-stream", async () => {
    const store = await SessionStore.create(cwd, "test");
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        call++;
        if (call === 2) throw new Error("Unexpected end of JSON input");
        return {
          stream: convertArrayToReadableStream(toolCallsRound([["c1", "todo_read", {}]])),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      sessionStore: store,
    });

    const events = await collect(loop.stream("go", new AbortController().signal));

    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(danglingToolCallIds(loop.getMessages())).toEqual([]);
    expect(danglingToolCallIds(await store.messages())).toEqual([]);
  });

  it("reconciles dangling tool calls passed to loadMessages", async () => {
    const loop = makeLoop(mockModel([textRound("ok")]));

    await loop.loadMessages([
      { role: "user", content: "hi" },
      assistantWithCalls([["c1", "bash"]]),
    ]);

    const messages = loop.getMessages();
    expect(messages).toHaveLength(3);
    expect(danglingToolCallIds(messages)).toEqual([]);
  });
});

describe("resumeSession repair", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "star-reconcile-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("repairs a poisoned session on resume and persists the fix", async () => {
    const store = await SessionStore.create("/tmp/work", "test");
    await store.append({ role: "user", content: "run something" });
    await store.append(assistantWithCalls([["fc_1", "bash"]]));
    expect(danglingToolCallIds(await store.messages())).toEqual(["fc_1"]);

    const resumed = await resumeSession(store.id);

    expect(resumed).not.toBeNull();
    expect(resumed?.messages).toHaveLength(3);
    expect(resumed?.messages[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "fc_1",
          toolName: "bash",
          result: MISSING_TOOL_RESULT_TEXT,
        },
      ],
    });
    expect(danglingToolCallIds(resumed?.messages ?? [])).toEqual([]);

    const reopened = await SessionStore.open(store.id);
    const persisted = await reopened?.messages();
    expect(persisted).toHaveLength(3);
    expect(danglingToolCallIds(persisted ?? [])).toEqual([]);
  });

  it("leaves a healthy session untouched on resume", async () => {
    const store = await SessionStore.create("/tmp/work", "test");
    await store.append({ role: "user", content: "hi" });
    await store.append(assistantWithCalls([["c1", "read_file"]]));
    await store.append({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", toolName: "read_file", result: "ok" }],
    });
    await store.append({ role: "assistant", content: "done" });
    const before = await store.messages();

    const resumed = await resumeSession(store.id);

    expect(resumed?.messages).toEqual(before);
    const reopened = await SessionStore.open(store.id);
    expect(await reopened?.messages()).toEqual(before);
  });
});
