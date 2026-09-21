import { describe, expect, it } from "vitest";
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
    describeConfig: () => "config summary",
    compactContext: async () => "compact result",
    exportSession: async (p) => `exported ${p}`,
    undo: async () => "undo result",
    rewind: async (args) => (args ? `rewound to ${args}` : "checkpoint list"),
    permissionMode: async (args) => (args ? `mode set ${args}` : "mode list"),
    planMode: async () => "plan toggled",
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

  it("/permission shows the mode list without args and sets a mode with args", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("permission")?.run("", ctx);
    await registry.get("permission")?.run("yolo", ctx);

    expect(calls).toEqual([
      { type: "system", text: "mode list" },
      { type: "system", text: "mode set yolo" },
    ]);
  });

  it("/plan toggles plan mode via the context hook", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("plan")?.run("", ctx);

    expect(calls).toEqual([{ type: "system", text: "plan toggled" }]);
  });

  it("/help lists all commands", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("help")?.run("", ctx);

    expect(calls).toHaveLength(1);
    const text = calls[0]?.text ?? "";
    for (const cmd of registry.list()) {
      expect(text).toContain(`/${cmd.name}`);
    }
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

  it("/model without args lists models, with args switches", async () => {
    const registry = makeRegistry();
    const switched: string[] = [];
    const { ctx, calls } = makeCtx({
      switchModel: async (name) => {
        switched.push(name);
        return `switched to ${name}`;
      },
    });

    await registry.get("model")?.run("", ctx);
    await registry.get("model")?.run("gpt-4o", ctx);

    expect(switched).toEqual(["gpt-4o"]);
    expect(calls).toEqual([
      { type: "system", text: "models list" },
      { type: "system", text: "switched to gpt-4o" },
    ]);
  });

  it("/resume without args lists sessions, with id resumes", async () => {
    const registry = makeRegistry();
    const resumed: string[] = [];
    const { ctx, calls } = makeCtx({
      resumeSession: async (id) => {
        resumed.push(id);
        return `resumed ${id}`;
      },
    });

    await registry.get("resume")?.run("", ctx);
    await registry.get("resume")?.run("abc123", ctx);

    expect(resumed).toEqual(["abc123"]);
    expect(calls).toEqual([
      { type: "system", text: "sessions list" },
      { type: "system", text: "resumed abc123" },
    ]);
  });

  it("/resume --all lists sessions across all directories", async () => {
    const registry = makeRegistry();
    const listed: (boolean | undefined)[] = [];
    const { ctx, calls } = makeCtx({
      listSessions: async (all) => {
        listed.push(all);
        return all ? "all sessions list" : "sessions list";
      },
    });

    await registry.get("resume")?.run("--all", ctx);
    await registry.get("resume")?.run("  --all  ", ctx);

    expect(listed).toEqual([true, true]);
    expect(calls).toEqual([
      { type: "system", text: "all sessions list" },
      { type: "system", text: "all sessions list" },
    ]);
  });
});
