import { describe, expect, it, vi } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const messages: string[] = [];
  const ctx: CommandContext = {
    addSystemMessage: (text) => messages.push(text),
    clearMessages: () => {},
    exit: () => {},
    listModels: () => "models",
    switchModel: async () => "switched",
    listSessions: async () => "sessions",
    resumeSession: async () => "resumed",
    showTodos: async () => "todos",
    listTasks: () => "tasks",
    showUsage: () => "usage",
    showGlobalUsage: async () => "global usage",
    describeConfig: () => "config",
    compactContext: async () => "compacted",
    exportSession: async () => "exported",
    undo: async () => "undone",
    rewind: async () => "rewound",
    permissionMode: async () => "mode",
    planMode: async () => "plan",
    pickModel: async () => "picked model",
    pickPermissionMode: async () => "picked mode",
    pickSession: async () => "picked session",
    forkSession: async () => "forked session",
    initProject: async () => "init",
    runDoctor: async () => "doctor",
    ...overrides,
  };
  return { ctx, messages };
}

function registryWithCopy() {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  const command = registry.get("copy");
  if (!command) throw new Error("/copy not registered");
  return command;
}

describe("/copy", () => {
  it("copies the last assistant reply and reports the char count", async () => {
    const copier = vi.fn().mockResolvedValue(true);
    const { ctx, messages } = makeCtx({
      conversationText: (scope) => (scope === "last" ? "the answer" : null),
      copyToClipboard: copier,
    });
    await registryWithCopy().run("", ctx);
    expect(copier).toHaveBeenCalledWith("the answer");
    expect(messages).toEqual(["Copied 10 chars to clipboard."]);
  });

  it("copies the whole conversation with /copy all", async () => {
    const copier = vi.fn().mockResolvedValue(true);
    const { ctx } = makeCtx({
      conversationText: () => "you: hi\n\nstar: hello",
      copyToClipboard: copier,
    });
    await registryWithCopy().run("all", ctx);
    expect(copier).toHaveBeenCalledWith("you: hi\n\nstar: hello");
  });

  it("rejects unknown arguments", async () => {
    const { ctx, messages } = makeCtx({
      conversationText: () => "x",
      copyToClipboard: async () => true,
    });
    await registryWithCopy().run("everything", ctx);
    expect(messages[0]).toContain('unknown argument "everything"');
  });

  it("notes when there is no assistant reply yet", async () => {
    const copier = vi.fn();
    const { ctx, messages } = makeCtx({ conversationText: () => null, copyToClipboard: copier });
    await registryWithCopy().run("", ctx);
    expect(copier).not.toHaveBeenCalled();
    expect(messages[0]).toContain("No assistant reply yet");
  });

  it("reports clipboard failure", async () => {
    const { ctx, messages } = makeCtx({
      conversationText: () => "the answer",
      copyToClipboard: async () => false,
    });
    await registryWithCopy().run("", ctx);
    expect(messages[0]).toContain("Copy failed");
  });

  it("notes when the context cannot access the clipboard", async () => {
    const { ctx, messages } = makeCtx();
    await registryWithCopy().run("", ctx);
    expect(messages[0]).toContain("cannot access the clipboard");
  });
});
