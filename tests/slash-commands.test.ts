import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import {
  type CommandContext,
  CommandRegistry,
  parseSlashCommand,
} from "../src/cli/commands/registry";

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const calls: { type: string; text?: string }[] = [];
  const ctx: CommandContext = {
    addSystemMessage: (text) => calls.push({ type: "system", text }),
    clearMessages: () => calls.push({ type: "clear" }),
    exit: () => calls.push({ type: "exit" }),
    listModels: () => "models list",
    switchModel: async (name) => `switched to ${name}`,
    listSessions: async (all) => (all ? "all sessions list" : "sessions list"),
    resumeSession: async (id) => `resumed ${id}`,
    showTodos: async () => "todos",
    listTasks: () => "tasks list",
    showUsage: () =>
      "API usage this session: 3 requests, 1234 prompt + 567 completion = 1801 tokens",
    showGlobalUsage: async () => "global usage dashboard",
    describeConfig: () => "config summary",
    compactContext: async () => "compact result",
    exportSession: async (p) => `exported ${p}`,
    undo: async () => "undo result",
    rewind: async (args) => (args ? `rewound to ${args}` : "checkpoint list"),
    permissionMode: async (args) => (args ? `mode set ${args}` : "mode list"),
    planMode: async () => "plan toggled",
    pickModel: async () => "picked model",
    pickPermissionMode: async () => "picked mode",
    pickSession: async (all) => (all ? "picked all sessions" : "picked session"),
    forkSession: async () => "forked session",
    initProject: async (args) => `init ${args}`,
    runDoctor: async () => "doctor report",
    ...overrides,
  };
  return { ctx, calls };
}

function makeRegistry() {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses a bare command", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: "" });
  });

  it("parses command with args", () => {
    expect(parseSlashCommand("/model gpt-4o  extra")).toEqual({
      name: "model",
      args: "gpt-4o  extra",
    });
  });

  it("returns null for a lone slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
  });
});

describe("CommandRegistry", () => {
  it("register/get/list", () => {
    const registry = new CommandRegistry();
    registry.register({ name: "b", description: "b", run: () => {} });
    registry.register({ name: "a", description: "a", run: () => {} });
    expect(registry.get("a")?.description).toBe("a");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("complete matches prefix with or without leading slash", () => {
    const registry = makeRegistry();
    expect(registry.complete("/ex").map((c) => c.name)).toEqual(["exit", "export"]);
    expect(registry.complete("re").map((c) => c.name)).toEqual(["resume", "rewind"]);
    expect(registry.complete("").length).toBe(registry.list().length);
    expect(registry.complete("/zzz")).toEqual([]);
  });

  it("dispatches builtin commands to context hooks", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("clear")?.run("", ctx);
    await registry.get("exit")?.run("", ctx);
    await registry.get("q")?.run("", ctx);
    await registry.get("todo")?.run("", ctx);
    await registry.get("cost")?.run("", ctx);
    await registry.get("config")?.run("", ctx);

    expect(calls).toEqual([
      { type: "clear" },
      { type: "exit" },
      { type: "exit" },
      { type: "system", text: "todos" },
      {
        type: "system",
        text: "API usage this session: 3 requests, 1234 prompt + 567 completion = 1801 tokens",
      },
      { type: "system", text: "config summary" },
    ]);
  });

  it("/q is registered as an alias of /exit", async () => {
    const registry = makeRegistry();
    const q = registry.get("q");
    expect(q?.description).toContain("exit");
    const { ctx, calls } = makeCtx();
    await q?.run("", ctx);
    expect(calls).toEqual([{ type: "exit" }]);
  });

  it("/permission opens the picker without args and sets a mode with args", async () => {
    const registry = makeRegistry();
    const picks: string[] = [];
    const { ctx, calls } = makeCtx({
      pickPermissionMode: async () => {
        picks.push("called");
        return "picked mode";
      },
    });

    await registry.get("permission")?.run("", ctx);
    await registry.get("permission")?.run("yolo", ctx);

    expect(picks).toEqual(["called"]);
    expect(calls).toEqual([
      { type: "system", text: "picked mode" },
      { type: "system", text: "mode set yolo" },
    ]);
  });

  it("/plan toggles plan mode via the context hook", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("plan")?.run("", ctx);

    expect(calls).toEqual([{ type: "system", text: "plan toggled" }]);
  });

  it("/help groups commands under category headers", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("help")?.run("", ctx);

    expect(calls).toHaveLength(1);
    const text = calls[0]?.text ?? "";
    expect(text).toContain("Available commands:");
    for (const header of ["General", "Sessions", "Changes", "Info", "Settings"]) {
      expect(text).toContain(`\n${header}\n`);
    }
    for (const cmd of registry.list()) {
      expect(text).toContain(`  ${cmd.usage ?? `/${cmd.name}`} - ${cmd.description}`);
    }
    // Grouped, not flat: the header precedes its commands.
    expect(text.indexOf("\nGeneral\n")).toBeLessThan(text.indexOf("  /exit"));
    expect(text.indexOf("\nSessions\n")).toBeLessThan(text.indexOf("  /resume"));
    expect(text.indexOf("\nSettings\n")).toBeLessThan(text.indexOf("  /model"));
  });

  it("/cost shows usage summary from context", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx({
      showUsage: () => "API usage this session: 1 requests, 10 prompt + 5 completion = 15 tokens",
    });

    await registry.get("cost")?.run("", ctx);

    expect(calls).toEqual([
      {
        type: "system",
        text: "API usage this session: 1 requests, 10 prompt + 5 completion = 15 tokens",
      },
    ]);
    expect(calls[0]?.text).toMatch(
      /^API usage this session: \d+ requests, \d+ prompt \+ \d+ completion = \d+ tokens$/,
    );
  });

  it("/model without args opens the picker, with args switches", async () => {
    const registry = makeRegistry();
    const switched: string[] = [];
    const picks: string[] = [];
    const { ctx, calls } = makeCtx({
      switchModel: async (name) => {
        switched.push(name);
        return `switched to ${name}`;
      },
      pickModel: async () => {
        picks.push("called");
        return "picked model";
      },
    });

    await registry.get("model")?.run("", ctx);
    await registry.get("model")?.run("gpt-4o", ctx);

    expect(picks).toEqual(["called"]);
    expect(switched).toEqual(["gpt-4o"]);
    expect(calls).toEqual([
      { type: "system", text: "picked model" },
      { type: "system", text: "switched to gpt-4o" },
    ]);
  });

  it("/resume without args picks a session, with id resumes directly", async () => {
    const registry = makeRegistry();
    const resumed: string[] = [];
    const picked: (boolean | undefined)[] = [];
    const { ctx, calls } = makeCtx({
      resumeSession: async (id) => {
        resumed.push(id);
        return `resumed ${id}`;
      },
      pickSession: async (all) => {
        picked.push(all);
        return "picked session";
      },
    });

    await registry.get("resume")?.run("", ctx);
    await registry.get("resume")?.run("abc123", ctx);

    expect(picked).toEqual([false]);
    expect(resumed).toEqual(["abc123"]);
    expect(calls).toEqual([
      { type: "system", text: "picked session" },
      { type: "system", text: "resumed abc123" },
    ]);
  });

  it("/resume --all picks across all directories", async () => {
    const registry = makeRegistry();
    const picked: (boolean | undefined)[] = [];
    const { ctx, calls } = makeCtx({
      pickSession: async (all) => {
        picked.push(all);
        return all ? "picked all sessions" : "picked session";
      },
    });

    await registry.get("resume")?.run("--all", ctx);
    await registry.get("resume")?.run("  --all  ", ctx);

    expect(picked).toEqual([true, true]);
    expect(calls).toEqual([
      { type: "system", text: "picked all sessions" },
      { type: "system", text: "picked all sessions" },
    ]);
  });

  it("/fork forks the session via the context hook", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("fork")?.run("", ctx);

    expect(calls).toEqual([{ type: "system", text: "forked session" }]);
  });

  describe("/memory", () => {
    let home: string;

    beforeEach(() => {
      home = mkdtempSync(path.join(tmpdir(), "star-memory-cmd-"));
      vi.stubEnv("STAR_HOME", home);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    });

    it("shows a hint with the path when the memory file is missing", async () => {
      const registry = makeRegistry();
      const { ctx, calls } = makeCtx();

      await registry.get("memory")?.run("", ctx);

      const text = calls[0]?.text ?? "";
      expect(text).toContain("No user memory yet");
      expect(text).toContain(path.join(home, "MEMORY.md"));
      expect(text).toContain("/memory add <text>");
    });

    it("shows the current memory content", async () => {
      writeFileSync(path.join(home, "MEMORY.md"), "- prefers pnpm\n", "utf8");
      const registry = makeRegistry();
      const { ctx, calls } = makeCtx();

      await registry.get("memory")?.run("", ctx);

      const text = calls[0]?.text ?? "";
      expect(text).toContain("User memory");
      expect(text).toContain("- prefers pnpm");
    });

    it("/memory add appends a bullet to the memory file", async () => {
      const registry = makeRegistry();
      const { ctx, calls } = makeCtx();

      await registry.get("memory")?.run("add uses vim keybindings", ctx);

      expect(calls).toEqual([
        { type: "system", text: "Saved to user memory: - uses vim keybindings" },
      ]);
      expect(readFileSync(path.join(home, "MEMORY.md"), "utf8")).toBe("- uses vim keybindings\n");
    });

    it("/memory add without text shows usage", async () => {
      const registry = makeRegistry();
      const { ctx, calls } = makeCtx();

      await registry.get("memory")?.run("add", ctx);

      expect(calls).toEqual([{ type: "system", text: "Usage: /memory add <text>" }]);
    });
  });

  it("/new starts a fresh session via the context hook", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx({
      newSession: async () => "new session started",
    });

    await registry.get("new")?.run("", ctx);

    expect(calls).toEqual([{ type: "system", text: "new session started" }]);
  });

  it("/clear-sessions clears this directory by default and everything with --all", async () => {
    const registry = makeRegistry();
    const cleared: boolean[] = [];
    const { ctx, calls } = makeCtx({
      clearSessions: async (all) => {
        cleared.push(all);
        return all ? "deleted all" : "deleted current dir";
      },
    });

    await registry.get("clear-sessions")?.run("", ctx);
    await registry.get("clear-sessions")?.run(" --all ", ctx);

    expect(cleared).toEqual([false, true]);
    expect(calls).toEqual([
      { type: "system", text: "deleted current dir" },
      { type: "system", text: "deleted all" },
    ]);
  });

  it("/clear-sessions rejects unknown arguments", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx({ clearSessions: async () => "deleted" });

    await registry.get("clear-sessions")?.run("everything", ctx);

    expect(calls).toEqual([
      {
        type: "system",
        text: '/clear-sessions: unknown argument "everything". Usage: /clear-sessions [--all]',
      },
    ]);
  });
});
