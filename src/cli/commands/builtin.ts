import type { CommandRegistry } from "./registry";

export function registerBuiltinCommands(registry: CommandRegistry): void {
  registry.register({
    name: "help",
    description: "List available commands",
    usage: "/help",
    run(_args, ctx) {
      const lines = registry.list().map((cmd) => {
        const usage = cmd.usage ?? `/${cmd.name}`;
        return `${usage} - ${cmd.description}`;
      });
      ctx.addSystemMessage(`Available commands:\n${lines.join("\n")}`);
    },
  });

  registry.register({
    name: "clear",
    description: "Clear message history",
    usage: "/clear",
    run(_args, ctx) {
      ctx.clearMessages();
    },
  });

  registry.register({
    name: "exit",
    description: "Exit the application",
    usage: "/exit",
    run(_args, ctx) {
      ctx.exit();
    },
  });

  registry.register({
    name: "q",
    description: "Exit the application (alias of /exit)",
    usage: "/q",
    run(_args, ctx) {
      ctx.exit();
    },
  });

  registry.register({
    name: "model",
    description: "List available models or switch the current model",
    usage: "/model [name]",
    async run(args, ctx) {
      if (!args) {
        ctx.addSystemMessage(ctx.listModels());
      } else {
        ctx.addSystemMessage(await ctx.switchModel(args));
      }
    },
  });

  registry.register({
    name: "resume",
    description: "List sessions or resume a session by id",
    usage: "/resume [sessionId]",
    async run(args, ctx) {
      if (!args) {
        ctx.addSystemMessage(await ctx.listSessions());
      } else {
        ctx.addSystemMessage(await ctx.resumeSession(args));
      }
    },
  });

  registry.register({
    name: "todo",
    description: "Show the current todo list",
    usage: "/todo",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.showTodos());
    },
  });

  registry.register({
    name: "cost",
    description: "Show API token usage for this session",
    usage: "/cost",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.showUsage());
    },
  });

  registry.register({
    name: "config",
    description: "Show the current configuration",
    usage: "/config",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.describeConfig());
    },
  });
}
