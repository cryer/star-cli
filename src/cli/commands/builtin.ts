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

  for (const name of ["model", "resume", "todo", "config"] as const) {
    registry.register({
      name,
      description: `${name} (not implemented)`,
      usage: `/${name}`,
      run(_args, ctx) {
        ctx.addSystemMessage("not implemented");
      },
    });
  }
}
