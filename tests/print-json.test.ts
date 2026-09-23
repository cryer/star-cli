import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { UsageTracker, eventToJsonLine } from "../src/cli/print-json";
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

function textRound(...texts: string[]): Chunk[] {
  return [
    ...texts.map((textDelta) => ({ type: "text-delta" as const, textDelta })),
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
    ...overrides,
  };
}

function toNdjson(events: StreamEvent[]): { lines: string[]; usageLine: string | null } {
  const usage = new UsageTracker();
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "finish") usage.add(event.usage);
    const line = eventToJsonLine(event);
    if (line) lines.push(line);
  }
  return { lines, usageLine: usage.toJsonLine() };
}

describe("eventToJsonLine", () => {
  it("serializes text-delta", () => {
    const line = eventToJsonLine({ type: "text-delta", text: "hello" });
    expect(line).toBe('{"type":"text-delta","text":"hello"}');
  });

  it("escapes newlines in text so every line stays single-line valid JSON", () => {
    const line = eventToJsonLine({ type: "text-delta", text: "line1\nline2\n" });
    expect(line).not.toContain("\n");
    expect(JSON.parse(line as string)).toEqual({ type: "text-delta", text: "line1\nline2\n" });
  });

  it("serializes tool-call reusing the StreamEvent shape", () => {
    const line = eventToJsonLine({
      type: "tool-call",
      id: "call-1",
      name: "read_file",
      args: { path: "a.txt" },
    });
    expect(JSON.parse(line as string)).toEqual({
      type: "tool-call",
      id: "call-1",
      name: "read_file",
      args: { path: "a.txt" },
    });
  });

  it("serializes tool-result with isError", () => {
    const line = eventToJsonLine({
      type: "tool-result",
      id: "call-1",
      name: "bash",
      content: "boom",
      isError: true,
    });
    expect(JSON.parse(line as string)).toEqual({
      type: "tool-result",
      id: "call-1",
      name: "bash",
      content: "boom",
      isError: true,
    });
  });

  it("serializes error events with a plain message object", () => {
    const line = eventToJsonLine({ type: "error", error: new Error("model exploded") });
    expect(JSON.parse(line as string)).toEqual({
      type: "error",
      error: { message: "model exploded" },
    });
  });

  it("serializes reasoning events", () => {
    const line = eventToJsonLine({ type: "reasoning", text: "let me think" });
    expect(line).toBe('{"type":"reasoning","text":"let me think"}');
  });

  it("returns null for finish events (folded into the usage summary)", () => {
    expect(eventToJsonLine({ type: "finish", finishReason: "stop" })).toBeNull();
  });
});

describe("UsageTracker", () => {
  it("returns null when no usage was recorded", () => {
    expect(new UsageTracker().toJsonLine()).toBeNull();
  });

  it("aggregates usage across requests", () => {
    const tracker = new UsageTracker();
    tracker.add({ promptTokens: 5, completionTokens: 3, totalTokens: 8 });
    tracker.add({ promptTokens: 10, completionTokens: 7, totalTokens: 17 });
    tracker.add(undefined);
    expect(JSON.parse(tracker.toJsonLine() as string)).toEqual({
      type: "usage",
      requests: 2,
      promptTokens: 15,
      completionTokens: 10,
      totalTokens: 25,
    });
  });
});

describe("print mode NDJSON over AgentLoop", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-print-json-test-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function makeLoop(model: MockLanguageModelV1): AgentLoop {
    return new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });
  }

  it("produces valid single-line JSON for a plain text reply", async () => {
    const loop = makeLoop(mockModel([textRound("Hello\n", "world")]));

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("hi", new AbortController().signal)) {
      events.push(event);
    }
    const { lines, usageLine } = toNdjson(events);

    const all = [...lines, ...(usageLine ? [usageLine] : [])];
    expect(all.length).toBeGreaterThan(0);
    for (const line of all) {
      expect(line).not.toContain("\n");
      expect(() => JSON.parse(line)).not.toThrow();
    }

    const parsed = lines.map((line) => JSON.parse(line));
    expect(
      parsed
        .filter((e) => e.type === "text-delta")
        .map((e) => e.text)
        .join(""),
    ).toBe("Hello\nworld");
    expect(JSON.parse(usageLine as string)).toMatchObject({
      type: "usage",
      requests: 1,
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
    });
  });

  it("covers tool-call, tool-result, text-delta and usage across a tool round", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "hello from file", "utf8");
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "read_file", { path: "note.txt" }),
        textRound("The file says hello"),
      ]),
    );

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("read note.txt", new AbortController().signal)) {
      events.push(event);
    }
    const { lines, usageLine } = toNdjson(events);

    const parsed = [...lines, usageLine]
      .filter((l): l is string => l !== null)
      .map((line) => JSON.parse(line));
    const types = parsed.map((e) => e.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("tool-result");
    expect(types).toContain("text-delta");
    expect(types).toContain("usage");

    const toolCall = parsed.find((e) => e.type === "tool-call");
    expect(toolCall).toMatchObject({ id: "call-1", name: "read_file", args: { path: "note.txt" } });

    const toolResult = parsed.find((e) => e.type === "tool-result");
    expect(toolResult.content).toContain("hello from file");

    const text = parsed
      .filter((e) => e.type === "text-delta")
      .map((e) => e.text)
      .join("");
    expect(text).toBe("The file says hello");

    expect(parsed.find((e) => e.type === "usage")).toMatchObject({ requests: 2 });
  });

  it("emits reasoning event lines when the model streams reasoning", async () => {
    const loop = makeLoop(
      mockModel([
        [
          { type: "reasoning", textDelta: "hmm" },
          { type: "text-delta", textDelta: "hi" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { promptTokens: 5, completionTokens: 3 },
          },
        ],
      ]),
    );

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("hi", new AbortController().signal)) {
      events.push(event);
    }
    const { lines } = toNdjson(events);

    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0]).toEqual({ type: "reasoning", text: "hmm" });
    expect(parsed[1]).toEqual({ type: "text-delta", text: "hi" });
  });

  it("emits an error event line when the loop fails", async () => {
    const loop = makeLoop(mockModel([toolCallRound("call-1", "nope_tool", {})]));

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("use nope_tool", new AbortController().signal)) {
      events.push(event);
    }
    const { lines } = toNdjson(events);

    const parsed = lines.map((line) => JSON.parse(line));
    const error = parsed.find((e) => e.type === "error");
    expect(error).toBeDefined();
    expect(error.error.message).toContain("nope_tool");
  });
});
