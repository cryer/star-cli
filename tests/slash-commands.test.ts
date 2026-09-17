import { describe, expect, it } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import {
  type CommandContext,
  CommandRegistry,
  parseSlashCommand,
} from "../src/cli/commands/registry";

function makeCtx() {
  const calls: { type: string; text?: string }[] = [];
  const ctx: CommandContext = {
    addSystemMessage: (text) => calls.push({ type: "system", text }),
    clearMessages: () => calls.push({ type: "clear" }),
    exit: () => calls.push({ type: "exit" }),
  };
  return { ctx, calls };
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
    registry.register({
      name: "b",
      description: "b",
      run: () => {},
    });
    registry.register({
      name: "a",
      description: "a",
      run: () => {},
    });
    expect(registry.get("a")?.description).toBe("a");
    expect(registry.get("missing")).toBeUndefined();
    expect(registry.list().map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("complete matches prefix with or without leading slash", () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    expect(registry.complete("/ex").map((c) => c.name)).toEqual(["exit"]);
    expect(registry.complete("re").map((c) => c.name)).toEqual(["resume"]);
    expect(registry.complete("").length).toBe(registry.list().length);
    expect(registry.complete("/zzz")).toEqual([]);
  });

  it("dispatches builtin commands to context hooks", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const { ctx, calls } = makeCtx();

    await registry.get("clear")?.run("", ctx);
    await registry.get("exit")?.run("", ctx);
    await registry.get("todo")?.run("", ctx);

    expect(calls).toEqual([
      { type: "clear" },
      { type: "exit" },
      { type: "system", text: "not implemented" },
    ]);
  });

  it("/help lists all commands", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const { ctx, calls } = makeCtx();

    await registry.get("help")?.run("", ctx);

    expect(calls).toHaveLength(1);
    const text = calls[0]?.text ?? "";
    for (const cmd of registry.list()) {
      expect(text).toContain(`/${cmd.name}`);
    }
  });

  it("placeholder commands report not implemented", async () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const { ctx, calls } = makeCtx();
    for (const name of ["model", "resume", "todo", "config"]) {
      await registry.get(name)?.run("anything", ctx);
    }
    expect(calls.map((c) => c.text)).toEqual([
      "not implemented",
      "not implemented",
      "not implemented",
      "not implemented",
    ]);
  });
});
