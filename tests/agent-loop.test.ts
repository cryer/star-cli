import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AgentLoop } from "../src/agent/loop";
import { PROJECT_MEMORY_MAX_CHARS } from "../src/agent/project-memory";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";
import type { Tool, ToolContext } from "../src/tools/types";

type Chunk =
  | { type: "text-delta"; textDelta: string }
  | { type: "reasoning"; textDelta: string }
  | { type: "error"; error: unknown }
  | {
      type: "tool-call";
      toolCallType: "function";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      type: "finish";
      finishReason: "stop" | "tool-calls" | "content-filter";
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

// Streams the given rounds like mockModel, and answers generateText (the
// completion check) with the verdicts in order, repeating the last one.
function judgeModel(verdicts: string[], rounds: Chunk[][]): MockLanguageModelV1 {
  let call = 0;
  let verdict = 0;
  return new MockLanguageModelV1({
    doStream: async () => {
      const chunks = rounds[Math.min(call, rounds.length - 1)] ?? [];
      call++;
      return {
        stream: convertArrayToReadableStream(chunks),
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
    doGenerate: async () => ({
      finishReason: "stop" as const,
      usage: { promptTokens: 1, completionTokens: 1 },
      text: verdicts[Math.min(verdict++, verdicts.length - 1)] ?? "",
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

describe("AgentLoop", () => {
  let cwd: string;
  let home: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-agent-test-"));
    home = mkdtempSync(path.join(tmpdir(), "star-agent-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
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
      // Near-zero retry backoff keeps failure-retry tests fast.
      retryDelayMs: 1,
    });
  }

  it("sends multimodal input to the model as image + text parts", async () => {
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream(textRound("It's a picture")),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const base64 = pngBytes.toString("base64");

    await collect(
      loop.stream(
        {
          text: "what is this?",
          images: [{ path: "pic.png", mimeType: "image/png", data: base64 }],
        },
        new AbortController().signal,
      ),
    );

    const messages = loop.getMessages();
    const userMessage = messages.find((m) => m.role === "user");
    expect(userMessage?.content).toEqual([
      { type: "image", image: base64, mimeType: "image/png" },
      { type: "text", text: "what is this?" },
    ]);

    const prompt = capturedPrompt as Array<{
      role: string;
      content: Array<{ type: string; mimeType?: string; image?: unknown; text?: string }>;
    }>;
    const promptUser = prompt.find((m) => m.role === "user");
    const parts = promptUser?.content ?? [];
    const imagePart = parts.find((p) => p.type === "image");
    const textPart = parts.find((p) => p.type === "text");
    expect(imagePart?.mimeType).toBe("image/png");
    expect(Buffer.from(imagePart?.image as Uint8Array).toString("base64")).toBe(base64);
    expect(textPart?.text).toBe("what is this?");
  });

  it("keeps multimodal input without images as a plain string message", async () => {
    const loop = makeLoop(mockModel([textRound("ok")]));

    await collect(loop.stream({ text: "hello", images: [] }, new AbortController().signal));

    const userMessage = loop.getMessages().find((m) => m.role === "user");
    expect(userMessage?.content).toBe("hello");
  });

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

  it("hides write/exec tools from the model in plan mode", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "write_file", {
          path: "out.txt",
          content: "secret",
        }),
      ]),
      { permissionMode: "plan" },
    );

    const events = await collect(loop.stream("write out.txt", new AbortController().signal));

    const error = events.find((e) => e.type === "error");
    expect(error).toBeDefined();
    if (error?.type === "error") {
      expect(error.error.message).toContain("unavailable tool 'write_file'");
    }
    expect(events.some((e) => e.type === "tool-result")).toBe(false);
    expect(existsSync(path.join(cwd, "out.txt"))).toBe(false);
  });

  it("still executes read tools in plan mode", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "read me", "utf8");
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "read_file", { path: "note.txt" }),
        textRound("plan ready"),
      ]),
      { permissionMode: "plan" },
    );

    const events = await collect(loop.stream("read note.txt", new AbortController().signal));

    const toolResult = events.find((e) => e.type === "tool-result");
    expect(toolResult).toMatchObject({ name: "read_file" });
    if (toolResult?.type === "tool-result") {
      expect(toolResult.isError).toBeFalsy();
      expect(toolResult.content).toContain("read me");
    }
  });

  it("adds the plan-mode system prompt only while plan mode is active", async () => {
    const config = makeConfig({ permissionMode: "plan" });
    const loop = new AgentLoop({
      model: mockModel([textRound("a plan")]),
      registry: createDefaultRegistry(),
      config,
      cwd,
      system: "BASE PROMPT",
    });

    await collect(loop.stream("plan this", new AbortController().signal));
    const head = loop.getMessages()[0];
    expect(head?.role).toBe("system");
    expect(head?.content).toContain("BASE PROMPT");
    expect(head?.content).toContain("PLAN MODE");

    config.permissionMode = "auto";
    await collect(loop.stream("do it", new AbortController().signal));
    expect(loop.getMessages()[0]?.content).toBe("BASE PROMPT");
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

  it("injects AGENTS.md from the cwd into the system message", async () => {
    writeFileSync(path.join(cwd, "AGENTS.md"), "Use pnpm, not npm.", "utf8");
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream(textRound("ok")),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    await collect(loop.stream("hi", new AbortController().signal));

    const system = (capturedPrompt as Array<{ role: string; content: string }>).find(
      (m) => m.role === "system",
    );
    expect(system?.content).toContain("# Project instructions (AGENTS.md)");
    expect(system?.content).toContain("Use pnpm, not npm.");
  });

  it("injects MEMORY.md from STAR_HOME into the system message", async () => {
    writeFileSync(path.join(home, "MEMORY.md"), "- prefers dark mode", "utf8");
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream(textRound("ok")),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    await collect(loop.stream("hi", new AbortController().signal));

    const system = (capturedPrompt as Array<{ role: string; content: string }>).find(
      (m) => m.role === "system",
    );
    expect(system?.content).toContain("# User memory (MEMORY.md)");
    expect(system?.content).toContain("- prefers dark mode");
  });

  it("leaves the system message unchanged when no AGENTS.md exists", async () => {
    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (options) => {
        capturedPrompt = options.prompt;
        return {
          stream: convertArrayToReadableStream(textRound("ok")),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      system: "BASE PROMPT",
    });

    await collect(loop.stream("hi", new AbortController().signal));

    const system = (capturedPrompt as Array<{ role: string; content: string }>).find(
      (m) => m.role === "system",
    );
    expect(system?.content).toBe("BASE PROMPT");
  });

  it("skips an empty AGENTS.md", async () => {
    writeFileSync(path.join(cwd, "AGENTS.md"), "  \n", "utf8");
    const loop = new AgentLoop({
      model: mockModel([textRound("ok")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      system: "BASE PROMPT",
    });

    await collect(loop.stream("hi", new AbortController().signal));

    expect(loop.getMessages()[0]?.content).toBe("BASE PROMPT");
  });

  it("truncates an oversized AGENTS.md with a note", async () => {
    writeFileSync(path.join(cwd, "AGENTS.md"), "x".repeat(PROJECT_MEMORY_MAX_CHARS * 2), "utf8");
    const loop = new AgentLoop({
      model: mockModel([textRound("ok")]),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      system: "BASE PROMPT",
    });

    await collect(loop.stream("hi", new AbortController().signal));

    const head = loop.getMessages()[0];
    expect(typeof head?.content).toBe("string");
    const content = head?.content as string;
    expect(content).toContain("# Project instructions (AGENTS.md)");
    expect(content).toContain("[AGENTS.md truncated");
    expect(content.length).toBeLessThanOrEqual(
      "BASE PROMPT".length + PROJECT_MEMORY_MAX_CHARS + 200,
    );
  });

  it("re-reads AGENTS.md when its mtime changes mid-session", async () => {
    const file = path.join(cwd, "AGENTS.md");
    writeFileSync(file, "version one", "utf8");
    const loop = makeLoop(mockModel([textRound("ok")]));

    await collect(loop.stream("hi", new AbortController().signal));
    expect(loop.getMessages()[0]?.content).toContain("version one");

    writeFileSync(file, "version two", "utf8");
    const bumped = new Date(Date.now() + 10_000);
    utimesSync(file, bumped, bumped);

    await collect(loop.stream("again", new AbortController().signal));
    const content = loop.getMessages()[0]?.content;
    expect(content).toContain("version two");
    expect(content).not.toContain("version one");
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

  it("retries a transient stream error and completes the turn", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        const chunks: Chunk[] =
          calls === 1 ? [{ type: "error", error: new Error("socket hang up") }] : textRound("ok");
        return {
          stream: convertArrayToReadableStream(chunks),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(calls).toBe(2);
    const retry = events.find((e) => e.type === "retry");
    expect(retry).toBeDefined();
    if (retry?.type === "retry") {
      expect(retry.attempt).toBe(2);
      expect(retry.maxAttempts).toBe(4);
      expect(retry.reason).toContain("socket hang up");
    }
    expect(events.some((e) => e.type === "error")).toBe(false);
    const assistant = loop.getMessages().find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "ok" }]);
  });

  it("retries an empty response instead of silently ending the turn", async () => {
    const loop = makeLoop(mockModel([[], textRound("recovered")]));

    const events = await collect(loop.stream("hi", new AbortController().signal));

    const retry = events.find((e) => e.type === "retry");
    expect(retry).toBeDefined();
    if (retry?.type === "retry") {
      expect(retry.reason).toContain("empty response");
    }
    const assistant = loop.getMessages().find((m) => m.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("gives up with a visible error after retries are exhausted", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream([
            { type: "error", error: new Error("relay down") } satisfies Chunk,
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model, { streamMaxRetries: 2 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(calls).toBe(3);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.message).toContain("relay down");
    }
  });

  it("does not retry non-retryable client errors", async () => {
    let calls = 0;
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        const error = new Error("Incorrect API key");
        error.name = "AI_APICallError";
        (error as unknown as { statusCode: number }).statusCode = 401;
        return {
          stream: convertArrayToReadableStream([{ type: "error", error } satisfies Chunk]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model);

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(calls).toBe(1);
    expect(events.some((e) => e.type === "retry")).toBe(false);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("ends an endlessly empty stream with an error after retries", async () => {
    const loop = makeLoop(mockModel([[]]), { streamMaxRetries: 1 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.message).toContain("empty response");
    }
  });

  it("steers an empty stop reply with a nudge after the retry budget is spent", async () => {
    const emptyStop: Chunk[] = [
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      },
    ];
    const loop = makeLoop(
      mockModel([
        emptyStop,
        emptyStop,
        toolCallRound("call-1", "todo_read", {}),
        textRound("全部完成。"),
      ]),
      { streamMaxRetries: 1 },
    );

    const events = await collect(loop.stream("hi", new AbortController().signal));

    // An empty stop is indistinguishable from a relay hiccup, so the full
    // retry budget is spent on identical resends before steering takes over.
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events.some((e) => e.type === "notice" && e.message.includes("empty reply"))).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const nudge = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("previous reply was empty"),
      );
    expect(nudge).toBeDefined();
  });

  it("recovers from an empty stop reply within the retry budget", async () => {
    const emptyStop: Chunk[] = [
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      },
    ];
    const loop = makeLoop(
      mockModel([
        emptyStop,
        emptyStop,
        toolCallRound("call-1", "todo_read", {}),
        textRound("全部完成。"),
      ]),
    );

    const events = await collect(loop.stream("hi", new AbortController().signal));

    // Both empty replies are resent (default budget of 3), the third attempt
    // succeeds, and no nudge is ever injected into the history.
    expect(events.filter((e) => e.type === "retry")).toHaveLength(2);
    expect(events.some((e) => e.type === "notice" && e.message.includes("empty reply"))).toBe(
      false,
    );
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(
      loop
        .getMessages()
        .some(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("previous reply was empty"),
        ),
    ).toBe(false);
  });

  it("steers a content-filtered empty reply after a single resend", async () => {
    let calls = 0;
    const filtered: Chunk[] = [
      {
        type: "finish",
        finishReason: "content-filter",
        usage: { promptTokens: 5, completionTokens: 0 },
      },
    ];
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream(filtered),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model, { streamMaxRetries: 3, maxAutoContinues: 0 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    // The filter judged the request itself, so an identical resend reproduces
    // the block deterministically: one confirmation resend, then stop.
    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("steers an empty reply that billed completion tokens after a single resend", async () => {
    let calls = 0;
    // Reasoning-model relay signature: the model generated (reasoning)
    // tokens — billed as completion tokens — but nothing visible arrived.
    const reasoningOnly: Chunk[] = [
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 240 },
      },
    ];
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream(reasoningOnly),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model, { streamMaxRetries: 3, maxAutoContinues: 0 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("steers a reply with reasoning but no visible output after a single resend", async () => {
    let calls = 0;
    const reasoningOnly: Chunk[] = [
      { type: "reasoning", textDelta: "thinking…" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 100, completionTokens: 240 },
      },
    ];
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream(reasoningOnly),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model, { streamMaxRetries: 3, maxAutoContinues: 0 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(calls).toBe(2);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("still errors on deliberate empty replies when nudging is disabled", async () => {
    const emptyStop: Chunk[] = [
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      },
    ];
    const loop = makeLoop(mockModel([emptyStop]), { streamMaxRetries: 1, maxAutoContinues: 0 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    expect(events.filter((e) => e.type === "retry")).toHaveLength(1);
    expect(events.some((e) => e.type === "notice")).toBe(false);
    const last = events[events.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.message).toContain("empty response");
    }
  });

  it("stops resending an endlessly empty reply once the retry budget is spent", async () => {
    let calls = 0;
    const emptyStop: Chunk[] = [
      {
        type: "finish",
        finishReason: "stop",
        usage: { promptTokens: 5, completionTokens: 0 },
      },
    ];
    const model = new MockLanguageModelV1({
      doStream: async () => {
        calls++;
        return {
          stream: convertArrayToReadableStream(emptyStop),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = makeLoop(model, { streamMaxRetries: 3, maxAutoContinues: 0 });

    const events = await collect(loop.stream("hi", new AbortController().signal));

    // Every attempt comes back empty, so the loop spends the whole retry
    // budget (initial + 3 resends) and then errors out instead of nudging.
    expect(calls).toBe(4);
    expect(events.filter((e) => e.type === "retry")).toHaveLength(3);
    expect(events[events.length - 1]?.type).toBe("error");
  });

  it("resets the auto-continue budget when the model makes progress between nudges", async () => {
    const loop = makeLoop(
      mockModel([
        textRound("我接下来会做这件事。"),
        toolCallRound("call-1", "todo_read", {}),
        textRound("我接下来会做这件事。"),
        toolCallRound("call-2", "todo_read", {}),
        textRound("全部完成。"),
      ]),
      { maxAutoContinues: 1 },
    );

    const events = await collect(loop.stream("do it", new AbortController().signal));

    // Progress between nudges earns the budget back: with a flat counter,
    // maxAutoContinues 1 would have stopped the turn after the first nudge.
    const continuations = events.filter(
      (e) => e.type === "notice" && e.message.includes("asking the model to continue"),
    );
    expect(continuations).toHaveLength(2);
    expect(
      events.some((e) => e.type === "notice" && e.message.includes("handing the turn back")),
    ).toBe(false);
  });

  it("nudges the model to continue when it stops after announcing pending work", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "todo_read", {}),
        textRound("检查完成，我会立即生成转换脚本并执行。"),
        toolCallRound("call-2", "todo_read", {}),
        textRound("全部完成。"),
      ]),
    );

    const events = await collect(loop.stream("convert the dataset", new AbortController().signal));

    expect(events.some((e) => e.type === "notice")).toBe(true);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(2);
    const nudge = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("auto-continue"),
      );
    expect(nudge).toBeDefined();
    const lastAssistant = [...loop.getMessages()].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toEqual([{ type: "text", text: "全部完成。" }]);
  });

  it("does not nudge when the final reply announces nothing pending", async () => {
    const loop = makeLoop(
      mockModel([toolCallRound("call-1", "todo_read", {}), textRound("配置里的模型是 gpt6。")]),
    );

    const events = await collect(loop.stream("what model?", new AbortController().signal));

    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(loop.getMessages().filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("caps auto-continue nudges at maxAutoContinues", async () => {
    const loop = makeLoop(mockModel([textRound("我接下来会做这件事。")]), {
      maxAutoContinues: 2,
    });

    const events = await collect(loop.stream("do it", new AbortController().signal));

    const notices = events.filter((e) => e.type === "notice");
    expect(
      notices.filter((e) => e.type === "notice" && e.message.includes("asking the model")),
    ).toHaveLength(2);
    const last = notices[notices.length - 1];
    expect(last?.type === "notice" && last.message.includes("handing the turn back")).toBe(true);
    expect(
      loop
        .getMessages()
        .filter(
          (m) =>
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.includes("auto-continue"),
        ),
    ).toHaveLength(2);
  });

  it("never nudges in plan mode", async () => {
    const loop = makeLoop(mockModel([textRound("我会先读取代码，然后给出计划。")]), {
      permissionMode: "plan",
    });

    const events = await collect(loop.stream("plan this", new AbortController().signal));

    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(loop.getMessages().filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("nudges on announcement phrasings beyond 我会/我将", async () => {
    const loop = makeLoop(
      mockModel([
        textRound("开始执行转换并写入 dataset 目录，完成后会核对数量。"),
        toolCallRound("call-1", "todo_read", {}),
        textRound("全部完成。"),
      ]),
    );

    const events = await collect(loop.stream("convert", new AbortController().signal));

    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
  });

  it("re-nudges when a nudge is answered with more words instead of tool calls", async () => {
    const loop = makeLoop(
      mockModel([
        textRound("我现在执行转换。"),
        textRound("正在处理数据。"),
        toolCallRound("call-1", "todo_read", {}),
        textRound("全部完成。"),
      ]),
    );

    const events = await collect(loop.stream("convert the dataset", new AbortController().signal));

    expect(events.filter((e) => e.type === "notice")).toHaveLength(2);
    expect(events.filter((e) => e.type === "tool-call")).toHaveLength(1);
    const lastAssistant = [...loop.getMessages()].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toEqual([{ type: "text", text: "全部完成。" }]);
  });

  it("stops when an ignored nudge hits the cap", async () => {
    const loop = makeLoop(mockModel([textRound("我现在执行转换。"), textRound("正在处理数据。")]), {
      maxAutoContinues: 1,
    });

    const events = await collect(loop.stream("convert", new AbortController().signal));

    const notices = events.filter((e) => e.type === "notice");
    expect(
      notices.filter((e) => e.type === "notice" && e.message.includes("asking the model")),
    ).toHaveLength(1);
    const last = notices[notices.length - 1];
    expect(last?.type === "notice" && last.message.includes("handing the turn back")).toBe(true);
    const nudges = loop
      .getMessages()
      .filter(
        (m) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("auto-continue"),
      );
    expect(nudges).toHaveLength(1);
    // The last-budget nudge warns the model no further nudge will follow.
    expect(
      typeof nudges[0]?.content === "string" &&
        nudges[0].content.includes("final automatic continuation"),
    ).toBe(true);
  });

  it("nudges when todo_write leaves open items at turn end", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "todo_write", {
          todos: [
            { id: 1, title: "写转换脚本", status: "in_progress" },
            { id: 2, title: "校验输出", status: "pending" },
          ],
        }),
        textRound("检查完成，目录结构正常。"),
        toolCallRound("call-2", "todo_write", {
          todos: [
            { id: 1, title: "写转换脚本", status: "done" },
            { id: 2, title: "校验输出", status: "done" },
          ],
        }),
        textRound("全部完成。"),
      ]),
    );

    const events = await collect(loop.stream("convert the dataset", new AbortController().signal));

    expect(events.filter((e) => e.type === "notice")).toHaveLength(1);
    const nudge = loop
      .getMessages()
      .find(
        (m) =>
          m.role === "user" && typeof m.content === "string" && m.content.includes("auto-continue"),
      );
    expect(typeof nudge?.content === "string" && nudge.content.includes("写转换脚本")).toBe(true);
  });

  it("nudges when the completion check reports NOT_DONE", async () => {
    const loop = makeLoop(
      judgeModel(
        ["NOT_DONE", "DONE"],
        [
          toolCallRound("call-1", "todo_read", {}),
          textRound("全量检查完成，目录结构正常。"),
          toolCallRound("call-2", "todo_read", {}),
          textRound("全部完成。"),
        ],
      ),
    );

    const events = await collect(loop.stream("convert the dataset", new AbortController().signal));

    const notices = events.filter((e) => e.type === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.type === "notice" && notices[0].message.includes("completion check")).toBe(
      true,
    );
    const lastAssistant = [...loop.getMessages()].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant?.content).toEqual([{ type: "text", text: "全部完成。" }]);
  });

  it("ends the turn when the completion check reports DONE", async () => {
    const loop = makeLoop(
      judgeModel(["DONE"], [toolCallRound("call-1", "todo_read", {}), textRound("结果如上。")]),
    );

    const events = await collect(loop.stream("what is in the file?", new AbortController().signal));

    expect(events.some((e) => e.type === "notice")).toBe(false);
    expect(loop.getMessages().filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("refuses the third identical tool call in a row (doom loop)", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("c1", "read_file", { path: "missing.txt" }),
        toolCallRound("c2", "read_file", { path: "missing.txt" }),
        toolCallRound("c3", "read_file", { path: "missing.txt" }),
        textRound("I am blocked"),
      ]),
    );

    const events = await collect(loop.stream("keep reading", new AbortController().signal));

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(3);
    if (results[0]?.type === "tool-result") {
      expect(results[0].content).not.toContain("Refused");
    }
    expect(results[2]).toMatchObject({ isError: true });
    if (results[2]?.type === "tool-result") {
      expect(results[2].content).toContain(
        'Refused: tool "read_file" was called 3 times in a row with identical arguments',
      );
    }
    const notice = events.find((e) => e.type === "notice");
    expect(notice?.type === "notice" && notice.message.includes("Refused")).toBe(true);
    // The refused call is persisted like any other tool result, so the
    // history stays replayable.
    const lastToolMessage = loop
      .getMessages()
      .filter((m) => m.role === "tool")
      .at(-1);
    expect(JSON.stringify(lastToolMessage)).toContain("Refused");
  });

  it("does not refuse repeats when doomLoopThreshold is 0", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("c1", "read_file", { path: "missing.txt" }),
        toolCallRound("c2", "read_file", { path: "missing.txt" }),
        toolCallRound("c3", "read_file", { path: "missing.txt" }),
        textRound("done"),
      ]),
      { doomLoopThreshold: 0 },
    );

    const events = await collect(loop.stream("keep reading", new AbortController().signal));

    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(3);
    expect(events.some((e) => e.type === "notice" && e.message.includes("Refused"))).toBe(false);
  });

  it("resets the doom-loop streak when the arguments change", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("c1", "read_file", { path: "a.txt" }),
        toolCallRound("c2", "read_file", { path: "a.txt" }),
        toolCallRound("c3", "read_file", { path: "b.txt" }),
        toolCallRound("c4", "read_file", { path: "b.txt" }),
        textRound("done"),
      ]),
    );

    const events = await collect(loop.stream("read files", new AbortController().signal));

    expect(events.filter((e) => e.type === "tool-result")).toHaveLength(4);
    expect(events.some((e) => e.type === "notice" && e.message.includes("Refused"))).toBe(false);
  });

  it("treats reordered argument keys as the same call", async () => {
    const loop = makeLoop(
      mockModel([
        toolCallRound("c1", "write_file", { path: "f.txt", content: "x" }),
        toolCallRound("c2", "write_file", { content: "x", path: "f.txt" }),
        toolCallRound("c3", "write_file", { path: "f.txt", content: "x" }),
        textRound("done"),
      ]),
    );

    const events = await collect(loop.stream("write", new AbortController().signal));

    const results = events.filter((e) => e.type === "tool-result");
    expect(results).toHaveLength(3);
    if (results[2]?.type === "tool-result") {
      expect(results[2].content).toContain(
        'Refused: tool "write_file" was called 3 times in a row',
      );
    }
  });

  it("drops turn markers when compaction rewrites the history", async () => {
    const loop = makeLoop(mockModel([textRound("ok")]), {
      contextMaxTokens: 90,
      contextCompaction: "truncate",
    });
    await loop.loadMessages([
      { role: "user", content: "x".repeat(400) },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
      { role: "assistant", content: "a3" },
    ]);

    await collect(loop.stream("hi", new AbortController().signal));

    // Compaction dropped exactly one message, so the retracted length would
    // collide with the stale marker's userIndex — a stale marker would
    // attribute /undo to the wrong snapshot turn. Cleared markers give none.
    const preview = loop.previewLastTurnRetraction();
    expect(preview.removed).toBeGreaterThan(0);
    expect(preview.turn).toBeUndefined();
  });

  it("passes turn-scoped snapshot context to tool execution", async () => {
    let seen: ToolContext["snapshotContext"];
    const spyTool: Tool = {
      name: "spy_tool",
      description: "captures the tool context",
      parameters: z.object({}),
      permission: "read",
      execute: async (_args, ctx) => {
        seen = ctx.snapshotContext;
        return { content: "ok" };
      },
    };
    const registry = createDefaultRegistry();
    registry.register(spyTool);
    const loop = new AgentLoop({
      model: mockModel([toolCallRound("c1", "spy_tool", {}), textRound("done")]),
      registry,
      config: makeConfig(),
      cwd,
    });

    await collect(loop.stream("hi", new AbortController().signal));

    // The turn seq comes from a process-wide counter shared with every other
    // loop in this test file, so only its presence is asserted.
    expect(seen?.owner).toBe("root");
    expect(seen?.messageIndex).toBe(0);
    expect(seen?.turn).toBeGreaterThan(0);
  });
});
