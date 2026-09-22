import { discoverSkills } from "../../agent/skills";
import {
  WORKING_DIFF_MAX_LINES,
  buildCommitPrompt,
  collectCommitContext,
  collectWorkingDiff,
  isGitRepo,
} from "../../core/git";
import { parseGitDiffLines } from "../diff-preview";
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
    name: "new",
    description: "Start a new session with a clean context",
    usage: "/new",
    async run(_args, ctx) {
      if (!ctx.newSession) {
        ctx.addSystemMessage("/new: this context cannot start a new session.");
        return;
      }
      ctx.addSystemMessage(await ctx.newSession());
    },
  });

  registry.register({
    name: "clear-sessions",
    description:
      "Delete stored sessions: this directory by default, every session with --all (the current session is kept)",
    usage: "/clear-sessions [--all]",
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
    usage: "/resume [sessionId | --all]",
    async run(args, ctx) {
      const arg = args.trim();
      if (arg === "--all") {
        ctx.addSystemMessage(await ctx.listSessions(true));
      } else if (!arg) {
        ctx.addSystemMessage(await ctx.listSessions());
      } else {
        ctx.addSystemMessage(await ctx.resumeSession(arg));
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
    name: "tasks",
    description: "List background shell tasks",
    usage: "/tasks",
    run(_args, ctx) {
      ctx.addSystemMessage(ctx.listTasks());
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
    name: "usage",
    description: "Show token usage aggregated across all sessions",
    usage: "/usage",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.showGlobalUsage());
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

  registry.register({
    name: "compact",
    description: "Compact the conversation history to free up context",
    usage: "/compact",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.compactContext());
    },
  });

  registry.register({
    name: "export",
    description: "Export the current session to a Markdown file",
    usage: "/export [path]",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.exportSession(args));
    },
  });

  registry.register({
    name: "permission",
    description: "Show or set the global permission mode (ask | auto | readonly | yolo)",
    usage: "/permission [ask|auto|readonly|yolo]",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.permissionMode(args.trim()));
    },
  });

  registry.register({
    name: "plan",
    description: "Toggle plan mode: read-only research, then approve the plan before executing",
    usage: "/plan",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.planMode());
    },
  });

  registry.register({
    name: "undo",
    description:
      "Undo the last conversation turn: revert its file changes (write_file/edit_file) and retract its messages",
    usage: "/undo",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.undo());
    },
  });

  registry.register({
    name: "rewind",
    description:
      "List file-change checkpoints, or rewind to just before one: restore files and retract the conversation",
    usage: "/rewind [n]",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.rewind(args.trim()));
    },
  });

  registry.register({
    name: "init",
    description: "Generate an AGENTS.md for the current project",
    usage: "/init [force]",
    async run(args, ctx) {
      ctx.addSystemMessage(await ctx.initProject(args));
    },
  });

  registry.register({
    name: "doctor",
    description: "Run environment and configuration checks",
    usage: "/doctor",
    async run(_args, ctx) {
      ctx.addSystemMessage(await ctx.runDoctor());
    },
  });

  registry.register({
    name: "skills",
    description: "List available skills (project scope overrides user scope)",
    usage: "/skills",
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

  registry.register({
    name: "commit",
    description: "Analyze uncommitted changes and create a git commit (Conventional Commits)",
    usage: "/commit [instructions]",
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

  registry.register({
    name: "copy",
    description:
      "Copy the last assistant reply to the clipboard (`all` for the whole conversation)",
    usage: "/copy [all]",
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

  registry.register({
    name: "diff",
    description: "Show uncommitted changes (git status + colored diff)",
    usage: "/diff",
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
