import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning"; textDelta: string }
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
    permissions: { allow: [] },
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

describe("AgentLoop", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-agent-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(
    model: MockLanguageModelV1,
    configOverrides: Partial<StarConfig> = {},
  ): AgentLoop {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(configOverrides),
      cwd,
    });
  }

  it("handles a plain text round trip", async () => {
    const loop = makeLoop(mockModel([textRound("Hello world")]));

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events).toEqual([
      { type: "text-delta", text: "Hello world" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      },
    ]);

    const messages = loop.getMessages();
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toEqual([{ type: "text", text: "Hello world" }]);
  });

  it("passes reasoning events through without adding them to history", async () => {
    const loop = makeLoop(
      mockModel([
        [
          { type: "reasoning", textDelta: "let me think" },
          { type: "text-delta", textDelta: "answer" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 3 },
          },
        ],
      ]),
    );

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events[0]).toEqual({ type: "reasoning", text: "let me think" });
    expect(events[1]).toEqual({ type: "text-delta", text: "answer" });

    const messages = loop.getMessages();
    const last = messages[messages.length - 1];
    expect(last?.role).toBe("assistant");
    expect(last?.content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("executes a tool call and continues with the result", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "hello from file", "utf8");
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "read_file", { path: "note.txt" }),
        textRound("The file says hello"),
      ]),
    );

    const events = await collect(loop.stream("read note.txt", new AbortController().signal));

    const toolCall = events.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({
      id: "call-1",
      name: "read_file",
      args: { path: "note.txt" },
    });

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("hello from file");
    }

    const text = events
      .filter((e) => e.type === "text-delta")
      .map((e) => (e.type === "text-delta" ? e.text : ""))
      .join("");
    expect(text).toBe("The file says hello");

    const messages = loop.getMessages();
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        args: { path: "note.txt" },
      },
    ]);
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
  });

  it("denies write tools in readonly mode", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "write_file", {
          path: "out.txt",
          content: "secret",
        }),
        textRound("done"),
      ]),
      { permissionMode: "readonly" },
    );

    const events = await collect(loop.stream("write out.txt", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ name: "write_file", isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("Permission denied");
    }
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
  });

  it("executes the tool when confirmHandler approves in ask mode", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "write_file", {
          path: "approved.txt",
          content: "yes",
        }),
        textRound("written"),
      ]),
      { permissionMode: "ask" },
    );
    loop.confirmHandler = async () => true;

    const events = await collect(loop.stream("write approved.txt", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toBeDefined();
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
    }
    expect(readFileSync(path.join(cwd, "approved.txt"), "utf8")).toBe("yes");
  });

  it("returns an error result when confirmHandler rejects in ask mode", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "write_file", {
          path: "rejected.txt",
          content: "no",
        }),
        textRound("not written"),
      ]),
      { permissionMode: "ask" },
    );
    loop.confirmHandler = async () => false;

    const events = await collect(loop.stream("write rejected.txt", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ name: "write_file", isError: true });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.content).toContain("User rejected");
    }
    expect(existsSync(path.join(cwd, "rejected.txt"))).toBe(false);
  });

  it("stops with an error when maxSteps is reached", async () => {
    const loop = makeLoop(mockModel([toolCallRound("call-1", "todo_read", {})]), {
      maxSteps: 2,
    });

    const events = await collect(loop.stream("loop forever", new AbortController().signal));

    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.message).toContain("Max steps (2)");
    }
    expect(events.filter((e) => e.type === "tool-result" && !e.isError)).toHaveLength(2);
  });

  it("errors when the model calls an unknown tool", async () => {
    const loop = makeLoop(mockModel([toolCallRound("call-1", "nope_tool", {})]));

    const events = await collect(loop.stream("use nope_tool", new AbortController().signal));

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") {
      expect(error.error.message).toContain("Model tried to call unavailable tool 'nope_tool'");
    }
    expect(events.some((e) => e.type === "tool-result")).toBe(false);
  });
});
