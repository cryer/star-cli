import type { DiffLine } from "../diff-preview";

export interface CommandContext {
  addSystemMessage(text: string): void;
  clearMessages(): void;
  exit(): void;
  listModels(): string;
  switchModel(name: string): Promise<string>;
  listSessions(all?: boolean): Promise<string>;
  resumeSession(id: string): Promise<string>;
  showTodos(): Promise<string>;
  listTasks(): string;
  showUsage(): string;
  showGlobalUsage(): Promise<string>;
  describeConfig(): string;
  compactContext(): Promise<string>;
  exportSession(path: string): Promise<string>;
  undo(): Promise<string>;
  rewind(args: string): Promise<string>;
  permissionMode(args: string): Promise<string>;
  planMode(): Promise<string>;
  initProject(args: string): Promise<string>;
  runDoctor(): Promise<string>;
  submitPrompt?(text: string): void | Promise<void>;
  // Working directory of the session; commands that shell out (e.g. /commit,
  // /diff) fall back to process.cwd() when the host does not provide it.
  cwd?: string;
  // Renders structured diff lines with per-line colors in the message area.
  showDiff?(text: string, lines: DiffLine[], note?: string): void;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  run(args: string, ctx: CommandContext): void | Promise<void>;
}

export class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
  }

  list(): SlashCommand[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name);
  }

  complete(prefix: string): SlashCommand[] {
    const stripped = prefix.startsWith("/") ? prefix.slice(1) : prefix;
    return this.list().filter((cmd) => cmd.name.startsWith(stripped));
  }
}

export interface ParsedCommand {
  name: string;
  args: string;
}

export function parseSlashCommand(input: string): ParsedCommand | null {
  if (!input.startsWith("/")) return null;
  const body = input.slice(1).trim();
  if (body.length === 0) return null;
  const spaceIndex = body.search(/\s/);
  if (spaceIndex === -1) return { name: body, args: "" };
  return {
    name: body.slice(0, spaceIndex),
    args: body.slice(spaceIndex).trim(),
  };
}
