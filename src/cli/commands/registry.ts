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
  // Interactive pickers backed by the REPL's SelectPrompt; each returns the
  // user-facing result text (an "unchanged" note when the picker is cancelled).
  pickModel(): Promise<string>;
  pickPermissionMode(): Promise<string>;
  pickSession(all?: boolean): Promise<string>;
  // Forks the live session into a new stored session and swaps to it.
  forkSession(): Promise<string>;
  initProject(args: string): Promise<string>;
  runDoctor(): Promise<string>;
  submitPrompt?(text: string): void | Promise<void>;
  // Starts a fresh session with a clean context (REPL-only).
  newSession?(): Promise<string>;
  // Runs the interactive provider-onboarding wizard (REPL-only).
  connect?(): Promise<string>;
  // Deletes stored sessions: current directory by default, every directory
  // when all is true. The live session is kept.
  clearSessions?(all: boolean): Promise<string>;
  // Working directory of the session; commands that shell out (e.g. /commit,
  // /diff) fall back to process.cwd() when the host does not provide it.
  cwd?: string;
  // Renders structured diff lines with per-line colors in the message area.
  showDiff?(text: string, lines: DiffLine[], note?: string): void;
  // Copies text to the system clipboard; resolves false when unavailable.
  copyToClipboard?(text: string): Promise<boolean>;
  // Plain-text conversation for /copy: "last" is the latest assistant reply,
  // "all" the whole conversation. null when there is nothing to copy.
  conversationText?(scope: "last" | "all"): string | null;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage?: string;
  // /help groups commands under this heading; uncategorized commands fall
  // into "Other".
  category?: string;
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
