import { readFileSync } from "node:fs";
import { discoverSkills } from "../../agent/skills";
import { appendUserMemory } from "../../agent/user-memory";
import { userMemoryPath } from "../../config/paths";
import {
  WORKING_DIFF_MAX_LINES,
  buildCommitPrompt,
  collectCommitContext,
  collectWorkingDiff,
  isGitRepo,
} from "../../core/git";
import { formatSearchResults, searchSessions } from "../../session/search";
import { parseGitDiffLines } from "../diff-preview";
import type { CommandRegistry, SlashCommand } from "./registry";

export function registerBuiltinCommands(registry: CommandRegistry): void {
  const register = (command: SlashCommand) => registry.register(command);

  register({
    name: "help",
    description: "List available commands",
    usage: "/help",
    category: "General",
    run(_args, ctx) {
      const groups = new Map<string, string[]>();
      for (const cmd of registry.list()) {
        const category = cmd.category ?? "Other";
        const usage = cmd.usage ?? `/${cmd.name}`;
        const lines = groups.get(category) ?? [];
        lines.push(`  ${usage} - ${cmd.description}`);
        groups.set(category, lines);
      }
      const sections = [...groups.entries()].map(([name, lines]) => [name, ...lines].join("\n"));
      ctx.addSystemMessage(`Available commands:\n\n${sections.join("\n\n")}`);
    },
  });

  register({
    name: "clear",
    description: "Clear message history",
    usage: "/clear",
    category: "General",
    run(_args, ctx) {
      ctx.clearMessages();
    },
  });

  register({
    name: "new",
    description: "Start a new session with a clean context",
    usage: "/new",
    category: "Sessions",
    async run(_args, ctx) {
      if (!ctx.newSession) {
        ctx.addSystemMessage("/new: this context cannot start a new session.");
        return;
      }
      ctx.addSystemMessage(await ctx.newSession());
    },
  });

  register({
    name: "clear-sessions",
    description:
      "Delete stored sessions: this directory by default, every session with --all (the current session is kept)",
    usage: "/clear-sessions [--all]",
    category: "Sessions",
    async run(args, ctx) {
      const arg = args.trim();
      if (arg !== "" && arg !== "--all") {
        ctx.addSystemMessage(
          `/clear-sessions: unknown argument "${arg}". Usage: /clear-sessions [--all]`,
        );
        return;
      }
      if (!ctx.clearSessions) {
        ctx.addSystemMessage("/clear-sessions: this context cannot delete sessions.");
        return;
      }
      ctx.addSystemMessage(await ctx.clearSessions(arg === "--all"));
    },
  });

  register({
    name: "exit",
    description: "Exit the application",
    usage: "/exit",
    category: "General",
    run(_args, ctx) {
      ctx.exit();
    },
  });

  register({
    name: "q",
    description: "Exit the application (alias of /exit)",
    usage: "/q",
    category: "General",
    run(_args, ctx) {
      ctx.exit();
    },
  });

  register({
    name: "model",
    description: "Switch the current model (opens a picker when no name is given)",
    usage: "/model [name]",
    category: "Settings",
    async run(args, ctx) {
      if (!args) {
        ctx.addSystemMessage(await ctx.pickModel());
      } else {
        ctx.addSystemMessage(await ctx.switchModel(args));
      }
    },
  });

  register({
    name: "resume",
    description: "Resume a session by id, or pick one from a list (--all for every directory)",
    usage: "/resume [sessionId | --all]",
    category: "Sessions",
    async run(args, ctx) {
      const arg = args.trim();
      if (arg === "--all") {
        ctx.addSystemMessage(await ctx.pickSession(true));
      } else if (!arg) {
        ctx.addSystemMessage(await ctx.pickSession(false));
      } else {
        ctx.addSystemMessage(await ctx.resumeSession(arg));
      }
    },
  });

  register({
    name: "fork",
    description: "Fork the current session into a new one and switch to it",
    usage: "/fork",
    category: "Sessions",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.forkSession());
    },
  });

  register({
    name: "search",
    description: "Full-text search across all stored sessions",
    usage: "/search <query>",
    category: "Sessions",
    async run(args, ctx) {
      const query = args.trim();
      if (!query) {
        ctx.addSystemMessage("Usage: /search <query>");
        return;
      }
      ctx.addSystemMessage(formatSearchResults(await searchSessions(query), query));
    },
  });

  register({
    name: "todo",
    description: "Show the current todo list",
    usage: "/todo",
    category: "Info",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.showTodos());
    },
  });

  register({
    name: "tasks",
    description: "List background shell tasks",
    usage: "/tasks",
    category: "Info",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.listTasks());
    },
  });

  register({
    name: "cost",
    description: "Show API token usage for this session",
    usage: "/cost",
    category: "Info",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.showUsage());
    },
  });

  register({
    name: "usage",
    description: "Show token usage aggregated across all sessions",
    usage: "/usage",
    category: "Info",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.showGlobalUsage());
    },
  });

  register({
    name: "config",
    description: "Show the current configuration",
    usage: "/config",
    category: "Info",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.describeConfig());
    },
  });

  register({
    name: "compact",
    description: "Compact the conversation history to free up context",
    usage: "/compact",
    category: "Sessions",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.compactContext());
    },
  });

  register({
    name: "export",
    description: "Export the current session to a Markdown file",
    usage: "/export [path]",
    category: "Sessions",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.exportSession(args));
    },
  });

  register({
    name: "permission",
    description: "Set the permission mode (opens a picker when no mode is given)",
    usage: "/permission [ask|auto|readonly|yolo]",
    category: "Settings",
    async run(args, ctx) {
      const arg = args.trim();
      if (!arg) {
        ctx.addSystemMessage(await ctx.pickPermissionMode());
      } else {
        ctx.addSystemMessage(await ctx.permissionMode(arg));
      }
    },
  });

  register({
    name: "plan",
    description: "Toggle plan mode: read-only research, then approve the plan before executing",
    usage: "/plan",
    category: "Settings",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.planMode());
    },
  });

  register({
    name: "memory",
    description: "Show user memory (MEMORY.md), or add an entry",
    usage: "/memory [add <text>]",
    category: "Settings",
    run(args, ctx) {
      const arg = args.trim();
      if (arg === "add" || arg.startsWith("add ")) {
        const text = arg.slice(3).trim();
        if (!text) {
          ctx.addSystemMessage("Usage: /memory add <text>");
          return;
        }
        appendUserMemory(text);
        ctx.addSystemMessage(`Saved to user memory: - ${text}`);
        return;
      }
      if (arg) {
        ctx.addSystemMessage(`Unknown argument "${arg}". Usage: /memory [add <text>]`);
        return;
      }
      const file = userMemoryPath();
      let content = "";
      try {
        content = readFileSync(file, "utf8").trim();
      } catch {
        content = "";
      }
      if (!content) {
        ctx.addSystemMessage(
          `No user memory yet (${file}).\nAdd entries with /memory add <text> or ask the agent to remember something.`,
        );
        return;
      }
      ctx.addSystemMessage(`User memory (${file}):\n${content}`);
    },
  });

  register({
    name: "undo",
    description:
      "Undo the last conversation turn: revert its file changes (write_file/edit_file) and retract its messages",
    usage: "/undo",
    category: "Changes",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.undo());
    },
  });

  register({
    name: "rewind",
    description:
      "List file-change checkpoints, or rewind to just before one: restore files and retract the conversation",
    usage: "/rewind [n]",
    category: "Changes",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.rewind(args.trim()));
    },
  });

  register({
    name: "init",
    description: "Generate an AGENTS.md for the current project",
    usage: "/init [force]",
    category: "Settings",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.initProject(args));
    },
  });

  register({
    name: "doctor",
    description: "Run environment and configuration checks",
    usage: "/doctor",
    category: "Info",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.runDoctor());
    },
  });

  register({
    name: "skills",
    description: "List available skills (project scope overrides user scope)",
    usage: "/skills",
    category: "Info",
    run(_args, ctx) {
      const skills = discoverSkills(ctx.cwd ?? process.cwd());
      if (skills.length === 0) {
        ctx.addSystemMessage(
          "No skills found. Add a SKILL.md under .star/skills/<name>/ (project) or ~/.star-cli/skills/<name>/ (user).",
        );
        return;
      }
      const lines = skills.map((s) => `${s.name} [${s.scope}] — ${s.description}`);
      ctx.addSystemMessage(`Available skills:\n${lines.join("\n")}`);
    },
  });

  register({
    name: "commit",
    description: "Analyze uncommitted changes and create a git commit (Conventional Commits)",
    usage: "/commit [instructions]",
    category: "Changes",
    async run(args, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      if (!isGitRepo(cwd)) {
        ctx.addSystemMessage("/commit: not a git repository — nothing to do.");
        return;
      }
      const context = collectCommitContext(cwd);
      if (!context) {
        ctx.addSystemMessage("/commit: working tree clean — nothing to commit.");
        return;
      }
      const prompt = buildCommitPrompt(context, args);
      if (ctx.submitPrompt) {
        return ctx.submitPrompt(prompt);
      }
      ctx.addSystemMessage("/commit: this context cannot submit prompts to the model.");
    },
  });

  register({
    name: "copy",
    description:
      "Copy the last assistant reply to the clipboard (`all` for the whole conversation)",
    usage: "/copy [all]",
    category: "Sessions",
    async run(args, ctx) {
      const arg = args.trim();
      if (arg !== "" && arg !== "all") {
        ctx.addSystemMessage(`/copy: unknown argument "${arg}". Usage: /copy [all]`);
        return;
      }
      if (!ctx.conversationText || !ctx.copyToClipboard) {
        ctx.addSystemMessage("/copy: this context cannot access the clipboard.");
        return;
      }
      const scope = arg === "all" ? "all" : "last";
      const text = ctx.conversationText(scope);
      if (!text) {
        ctx.addSystemMessage(
          scope === "all" ? "Nothing to copy yet." : "No assistant reply yet — nothing to copy.",
        );
        return;
      }
      const ok = await ctx.copyToClipboard(text);
      ctx.addSystemMessage(
        ok
          ? `Copied ${text.length} chars to clipboard.`
          : "Copy failed — no clipboard command available on this platform.",
      );
    },
  });

  register({
    name: "diff",
    description: "Show uncommitted changes (git status + colored diff)",
    usage: "/diff",
    category: "Changes",
    run(_args, ctx) {
      const cwd = ctx.cwd ?? process.cwd();
      if (!isGitRepo(cwd)) {
        ctx.addSystemMessage("/diff: not a git repository — nothing to show.");
        return;
      }
      const result = collectWorkingDiff(cwd);
      if (!result || result.status === "") {
        ctx.addSystemMessage("Working tree clean — no uncommitted changes.");
        return;
      }
      const header = `git status --short:\n${result.status}`;
      if (result.diff === "") {
        ctx.addSystemMessage(
          `${header}\n\nOnly untracked files — no tracked modifications to diff.`,
        );
        return;
      }
      const note = result.truncated
        ? `diff truncated at ${WORKING_DIFF_MAX_LINES} lines`
        : undefined;
      if (ctx.showDiff) {
        ctx.showDiff(header, parseGitDiffLines(result.diff), note);
        return;
      }
      ctx.addSystemMessage(`${header}\n\n${result.diff}${note ? `\n... (${note})` : ""}`);
    },
  });
}
