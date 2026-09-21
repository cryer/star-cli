import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { loadConfig } from "../src/config/loader";
import { globalConfigPath } from "../src/config/paths";
import { type HookConfig, HookConfigSchema, type StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { SessionStore } from "../src/session/store";
import { createDefaultRegistry } from "../src/tools";
import { clearSnapshots, setSnapshotHooks } from "../src/tools/fs/snapshots";

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

function makeHook(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    event: "PreToolUse",
    command: 'node -e "process.exit(0)"',
    timeoutSec: 30,
    ...overrides,
  };
}

function makeConfig(hooks: HookConfig[]): StarConfig {
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
    hooks,
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-hooks-home-"));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "star-hooks-cwd-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  setSnapshotHooks(null);
  clearSnapshots();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function makeLoop(
  model: MockLanguageModelV1,
  hooks: HookConfig[],
  warnings: string[],
  sessionStore?: SessionStore,
): AgentLoop {
  const loop = new AgentLoop({
    model,
    registry: createDefaultRegistry(),
    config: makeConfig(hooks),
    cwd,
    sessionStore,
  });
  loop.onHookWarning = (message) => warnings.push(message);
  return loop;
}

function writeFileCall(id: string, fileName: string, content: string): Chunk[] {
  return toolCallRound(id, "write_file", { path: fileName, content });
}

describe("HookConfigSchema", () => {
  it("applies the default timeout", () => {
    const hook = HookConfigSchema.parse({ event: "PreToolUse", command: "echo hi" });
    expect(hook.timeoutSec).toBe(30);
    expect(hook.matcher).toBeUndefined();
  });

  it("rejects an unknown event", () => {
    expect(() => HookConfigSchema.parse({ event: "OnBoot", command: "echo hi" })).toThrow();
  });

  it("rejects an empty command", () => {
    expect(() => HookConfigSchema.parse({ event: "Stop", command: "" })).toThrow();
  });

  it("rejects an invalid matcher regex", () => {
    expect(() =>
      HookConfigSchema.parse({ event: "PreToolUse", matcher: "([", command: "echo hi" }),
    ).toThrow(/invalid regular expression/);
  });

  it("accepts a valid matcher and timeout override", () => {
    const hook = HookConfigSchema.parse({
      event: "PostToolUse",
      matcher: "edit_file|write_file",
      command: "biome check --write .",
      timeoutSec: 5,
    });
    expect(hook.matcher).toBe("edit_file|write_file");
    expect(hook.timeoutSec).toBe(5);
  });
});

describe("hooks in config files", () => {
  it("loads hooks from TOML", async () => {
    fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
    fs.writeFileSync(
      globalConfigPath(),
      `[[hooks]]
event = "PreToolUse"
matcher = "edit_file|write_file"
command = "biome check --write ."

[[hooks]]
event = "Stop"
command = "echo done"
timeoutSec = 10
`,
    );
    const config = await loadConfig(cwd);
    expect(config.hooks).toHaveLength(2);
    expect(config.hooks[0]).toEqual({
      event: "PreToolUse",
      matcher: "edit_file|write_file",
      command: "biome check --write .",
      timeoutSec: 30,
    });
    expect(config.hooks[1]?.timeoutSec).toBe(10);
  });

  it("fails config loading with a clear error on an invalid hook", async () => {
    fs.mkdirSync(path.dirname(globalConfigPath()), { recursive: true });
    fs.writeFileSync(
      globalConfigPath(),
      `[[hooks]]
event = "Sometimes"
command = "echo hi"
`,
    );
    await expect(loadConfig(cwd)).rejects.toThrow(/Invalid config/);
  });
});

describe("PreToolUse hooks", () => {
  it("blocks the tool on exit code 2 and feeds stderr back as the tool result", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "blocked.txt", "x"), textRound("done")]),
      [
        makeHook({
          command: "node -e \"process.stderr.write('no secrets'); process.exit(2)\"",
        }),
      ],
      warnings,
    );

    const events = await collect(loop.stream("write a file", new AbortController().signal));

    const result = events.find((e) => e.type === "tool-result");
    if (result?.type !== "tool-result") throw new Error("expected a tool-result event");
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blocked by a PreToolUse hook");
    expect(result.content).toContain("no secrets");
    expect(fs.existsSync(path.join(cwd, "blocked.txt"))).toBe(false);
  });

  it("lets the tool run on exit code 0", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "ok.txt", "hello"), textRound("done")]),
      [makeHook()],
      warnings,
    );

    await collect(loop.stream("write a file", new AbortController().signal));

    expect(fs.readFileSync(path.join(cwd, "ok.txt"), "utf8")).toBe("hello");
    expect(warnings).toEqual([]);
  });

  it("warns but does not block on other non-zero exit codes", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "warn.txt", "hello"), textRound("done")]),
      [makeHook({ command: "node -e \"process.stderr.write('lint failed'); process.exit(1)\"" })],
      warnings,
    );

    await collect(loop.stream("write a file", new AbortController().signal));

    expect(fs.existsSync(path.join(cwd, "warn.txt"))).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("exited with code 1");
    expect(warnings[0]).toContain("lint failed");
  });

  it("treats a timeout as allow-with-warning, not a block", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "timeout.txt", "hello"), textRound("done")]),
      [makeHook({ command: 'node -e "setTimeout(() => {}, 10000)"', timeoutSec: 1 })],
      warnings,
    );

    const start = Date.now();
    await collect(loop.stream("write a file", new AbortController().signal));
    const elapsed = Date.now() - start;

    expect(fs.existsSync(path.join(cwd, "timeout.txt"))).toBe(true);
    expect(elapsed).toBeLessThan(8000);
    expect(warnings.some((w) => w.includes("timed out"))).toBe(true);
  });

  it("only runs hooks whose matcher matches the tool name", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "other.txt", "hello"), textRound("done")]),
      [makeHook({ matcher: "edit_file", command: 'node -e "process.exit(2)"' })],
      warnings,
    );

    await collect(loop.stream("write a file", new AbortController().signal));

    expect(fs.existsSync(path.join(cwd, "other.txt"))).toBe(true);
  });

  it("passes tool and session context via environment variables", async () => {
    const store = await SessionStore.create(cwd, "test-model");
    const warnings: string[] = [];
    const hook = makeHook({
      command:
        "node -e \"require('fs').writeFileSync('env.json', JSON.stringify({e: process.env.STAR_HOOK_EVENT, n: process.env.STAR_TOOL_NAME, i: process.env.STAR_TOOL_INPUT, s: process.env.STAR_SESSION_ID, c: process.env.STAR_CWD}))\"",
    });
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "env-target.txt", "body"), textRound("done")]),
      [hook],
      warnings,
      store,
    );

    await collect(loop.stream("write a file", new AbortController().signal));

    const env = JSON.parse(fs.readFileSync(path.join(cwd, "env.json"), "utf8"));
    expect(env.e).toBe("PreToolUse");
    expect(env.n).toBe("write_file");
    expect(JSON.parse(env.i)).toEqual({ path: "env-target.txt", content: "body" });
    expect(env.s).toBe(store.id);
    expect(env.c).toBe(cwd);
  });
});

describe("PostToolUse hooks", () => {
  it("runs after a successful tool execution", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "post-target.txt", "hello"), textRound("done")]),
      [
        makeHook({
          event: "PostToolUse",
          command: "node -e \"require('fs').writeFileSync('post.txt', 'ran')\"",
        }),
      ],
      warnings,
    );

    await collect(loop.stream("write a file", new AbortController().signal));

    expect(fs.readFileSync(path.join(cwd, "post.txt"), "utf8")).toBe("ran");
    expect(warnings).toEqual([]);
  });

  it("does not run when the tool result is an error", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([toolCallRound("c1", "read_file", { path: "missing.txt" }), textRound("done")]),
      [
        makeHook({
          event: "PostToolUse",
          command: "node -e \"require('fs').writeFileSync('post.txt', 'ran')\"",
        }),
      ],
      warnings,
    );

    await collect(loop.stream("read a file", new AbortController().signal));

    expect(fs.existsSync(path.join(cwd, "post.txt"))).toBe(false);
  });

  it("warns on failure without blocking the flow", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([writeFileCall("c1", "pw.txt", "hello"), textRound("done")]),
      [
        makeHook({
          event: "PostToolUse",
          command: "node -e \"process.stderr.write('format failed'); process.exit(3)\"",
        }),
      ],
      warnings,
    );

    const events = await collect(loop.stream("write a file", new AbortController().signal));

    expect(fs.existsSync(path.join(cwd, "pw.txt"))).toBe(true);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("PostToolUse");
    expect(warnings[0]).toContain("format failed");
  });
});

describe("Stop hooks", () => {
  it("runs once when a turn completes without tool calls", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([textRound("all done")]),
      [
        makeHook({
          event: "Stop",
          command:
            "node -e \"require('fs').writeFileSync('stop.json', JSON.stringify({e: process.env.STAR_HOOK_EVENT, n: process.env.STAR_TOOL_NAME ?? null}))\"",
        }),
      ],
      warnings,
    );

    await collect(loop.stream("just chat", new AbortController().signal));

    const payload = JSON.parse(fs.readFileSync(path.join(cwd, "stop.json"), "utf8"));
    expect(payload.e).toBe("Stop");
    expect(payload.n).toBeNull();
  });

  it("runs once at the end of a multi-step tool turn", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([
        writeFileCall("c1", "a.txt", "x"),
        writeFileCall("c2", "b.txt", "y"),
        textRound("done"),
      ]),
      [
        makeHook({
          event: "Stop",
          command: "node -e \"require('fs').appendFileSync('stops.txt', 'x')\"",
        }),
      ],
      warnings,
    );

    await collect(loop.stream("do work", new AbortController().signal));

    expect(fs.readFileSync(path.join(cwd, "stops.txt"), "utf8")).toBe("x");
  });

  it("survives a failing Stop hook without affecting the turn", async () => {
    const warnings: string[] = [];
    const loop = makeLoop(
      mockModel([textRound("fine")]),
      [makeHook({ event: "Stop", command: 'node -e "process.exit(1)"' })],
      warnings,
    );

    const events = await collect(loop.stream("chat", new AbortController().signal));

    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(warnings).toHaveLength(1);
  });
});
