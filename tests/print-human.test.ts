import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { printEventLine } from "../src/cli/print-human";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

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
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: false,
    webFetchAllowPrivateHosts: false,
    ...overrides,
  };
}

describe("printEventLine", () => {
  it("passes text deltas to stdout", () => {
    expect(printEventLine({ type: "text-delta", text: "hello" })).toEqual({
      stream: "stdout",
      text: "hello",
    });
  });

  it("renders tool-call args as the one-line summary, not the full JSON", () => {
    const bigArgs = { path: "a.ts", content: "x".repeat(500) };
    const line = printEventLine({ type: "tool-call", id: "c1", name: "write_file", args: bigArgs });
    expect(line?.stream).toBe("stderr");
    expect(line?.text).toMatch(/^\n\[tool\] write_file /);
    expect(line?.text).toContain("...");
    expect(line?.text).not.toContain("x".repeat(500));
    expect(line?.text).not.toContain(JSON.stringify(bigArgs));
  });

  it("keeps small tool-call args intact in the summary (same digest as the REPL cards)", () => {
    const line = printEventLine({
      type: "tool-call",
      id: "c1",
      name: "read_file",
      args: { path: "note.txt" },
    });
    expect(line?.text).toBe('\n[tool] read_file {"path":"note.txt"}\n');
  });

  it("truncates long tool results and flags errors", () => {
    const long = printEventLine({
      type: "tool-result",
      id: "c1",
      name: "bash",
      content: "y".repeat(600),
    });
    expect(long?.text).toBe(`[result] ${"y".repeat(500)}... (truncated)\n`);
    const failed = printEventLine({
      type: "tool-result",
      id: "c1",
      name: "bash",
      content: "boom",
      isError: true,
    });
    expect(failed?.text).toBe("[result] ERROR: boom\n");
  });

  it("renders retry, notice and error lines on stderr", () => {
    expect(
      printEventLine({ type: "retry", attempt: 2, maxAttempts: 5, delayMs: 4000, reason: "boom" })
        ?.text,
    ).toBe("\n[retry 2/5 in 4s] boom\n");
    expect(
      printEventLine({ type: "retry", attempt: 1, maxAttempts: 5, delayMs: 300, reason: "boom" })
        ?.text,
    ).toBe("\n[retry 1/5] boom\n");
    expect(printEventLine({ type: "notice", message: "heads up" })?.text).toBe(
      "\n[notice] heads up\n",
    );
    expect(
      printEventLine({ type: "error", error: { name: "Error", message: "kaput" } })?.text,
    ).toBe("\n[error] kaput\n");
    expect(
      printEventLine({
        type: "error",
        error: { name: "SyntaxError", message: "Unexpected end of JSON input" },
      })?.text,
    ).toBe("\n[error] Unexpected end of JSON input (response stream was truncated — try again)\n");
  });

  it("ignores reasoning, tool-call progress and finish events", () => {
    expect(printEventLine({ type: "reasoning", text: "hmm" })).toBeNull();
    expect(
      printEventLine({ type: "tool-call-progress", name: "write_file", bytes: 4096 }),
    ).toBeNull();
    expect(printEventLine({ type: "finish", finishReason: "stop" })).toBeNull();
  });
});

describe("print mode human-readable output over AgentLoop", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-print-human-test-"));
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

  // Mirrors the !json branch of printMode in src/main.tsx.
  function renderHuman(events: StreamEvent[]): { stdout: string; stderr: string } {
    let stdout = "";
    let stderr = "";
    for (const event of events) {
      const line = printEventLine(event);
      if (!line) continue;
      if (line.stream === "stdout") stdout += line.text;
      else stderr += line.text;
    }
    return { stdout, stderr };
  }

  it("streams text to stdout and tool summaries (not full args JSON) to stderr", async () => {
    writeFileSync(path.join(cwd, "note.txt"), "hello from file", "utf8");
    const bigArgs = { path: "big.txt", content: "x".repeat(500) };
    const loop = makeLoop(
      mockModel([
        toolCallRound("call-1", "write_file", bigArgs),
        toolCallRound("call-2", "read_file", { path: "note.txt" }),
        textRound("Done"),
      ]),
    );

    const events: StreamEvent[] = [];
    for await (const event of loop.stream("write then read", new AbortController().signal)) {
      events.push(event);
    }
    const { stdout, stderr } = renderHuman(events);

    expect(stdout).toBe("Done");
    expect(stderr).toContain("[tool] write_file ");
    expect(stderr).toContain('[tool] read_file {"path":"note.txt"}');
    // The human path carries the digest only; the full argument payload would
    // flood the terminal.
    expect(stderr).not.toContain(JSON.stringify(bigArgs));
    expect(stderr).not.toContain("x".repeat(500));
    expect(stderr).toContain("[result] ");
  });
});
