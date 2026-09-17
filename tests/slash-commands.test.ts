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
    listSessions: async () => "sessions list",
    resumeSession: async (id) => `resumed ${id}`,
    showTodos: async () => "todos",
    describeConfig: () => "config summary",
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
    expect(registry.complete("/ex").map((c) => c.name)).toEqual(["exit"]);
    expect(registry.complete("re").map((c) => c.name)).toEqual(["resume"]);
    expect(registry.complete("").length).toBe(registry.list().length);
    expect(registry.complete("/zzz")).toEqual([]);
  });

  it("dispatches builtin commands to context hooks", async () => {
    const registry = makeRegistry();
    const { ctx, calls } = makeCtx();

    await registry.get("clear")?.run("", ctx);
    await registry.get("exit")?.run("", ctx);
    await registry.get("todo")?.run("", ctx);
    await registry.get("config")?.run("", ctx);

    expect(calls).toEqual([
      { type: "clear" },
      { type: "exit" },
      { type: "system", text: "todos" },
      { type: "system", text: "config summary" },
    ]);
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
});
