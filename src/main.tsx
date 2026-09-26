import { Command } from "commander";
import { defaultAgentTasks } from "./agent/agent-tasks";
import { AgentLoop } from "./agent/loop";
import { formatStreamError } from "./cli/format";
import { MAX_IMAGE_BYTES, imageMimeType, readImageInput, resolveMentions } from "./cli/mentions";
import { UsageTracker, eventToJsonLine } from "./cli/print-json";
import { renderRepl } from "./cli/repl";
import { SYSTEM_PROMPT } from "./cli/system-prompt";
import { loadConfigSync } from "./config/loader";
import { type StarConfig, contextWindowTokens } from "./config/schema";
import { type CoreMessage, type ImageInput, reconcileToolCalls } from "./core/messages";
import { createModel } from "./llm/provider";
import { loadSessionSnapshots } from "./session/checkpoints";
import { clearSessions } from "./session/clear";
import {
  findLatestSession,
  formatSessionEntries,
  listSessionEntries,
  resolveSessionId,
} from "./session/list";
import { type SessionMeta, SessionStore } from "./session/store";
import { defaultTaskManager } from "./tasks/manager";
import { createDefaultRegistry } from "./tools";
import { hydrateSnapshots } from "./tools/fs/snapshots";
import { loadTodos } from "./tools/todo";
import { VERSION } from "./version";

async function createLoop(
  config: StarConfig,
  modelName: string,
  cwd: string,
  sessionStore: SessionStore | null,
) {
  const model = createModel(config, modelName);
  const registry = createDefaultRegistry();
  return new AgentLoop({
    model,
    registry,
    config,
    cwd,
    system: SYSTEM_PROMPT,
    sessionStore,
    contextMaxTokens: contextWindowTokens(config, modelName),
  });
}

async function printMode(
  loop: AgentLoop,
  prompt: string,
  cwd: string,
  json: boolean,
  imagePaths: string[],
  sessionStore: SessionStore | null,
): Promise<number> {
  const flagImages: ImageInput[] = [];
  for (const imagePath of imagePaths) {
    if (!imageMimeType(imagePath)) {
      process.stderr.write(
        `[error] unsupported image type: ${imagePath} (supported: png, jpg, jpeg, gif, webp)\n`,
      );
      return 1;
    }
    const image = await readImageInput(imagePath, cwd);
    if (!image) {
      process.stderr.write(
        `[error] cannot read image: ${imagePath} (missing, unreadable, or larger than ${MAX_IMAGE_BYTES / (1024 * 1024)}MB)\n`,
      );
      return 1;
    }
    flagImages.push(image);
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  loop.onHookWarning = (message) => {
    process.stderr.write(`[hook] ${message}\n`);
  };
  const resolved = await resolveMentions(prompt, cwd);
  if (resolved.attached.length > 0) {
    process.stderr.write(`[attached] ${resolved.attached.join(", ")}\n`);
  }
  for (const skip of resolved.skipped) {
    process.stderr.write(`[skipped] @${skip.path}: ${skip.reason}\n`);
  }
  const images = [...flagImages, ...resolved.images];
  const input: string | { text: string; images: ImageInput[] } =
    images.length > 0 ? { text: resolved.input, images } : resolved.input;
  const usage = new UsageTracker();
  let exitCode = 0;
  try {
    for await (const event of loop.stream(input, controller.signal, {
      persistAs: prompt,
    })) {
      if (json) {
        const line = eventToJsonLine(event);
        if (line) process.stdout.write(`${line}\n`);
      }
      switch (event.type) {
        case "text-delta":
          if (!json) process.stdout.write(event.text);
          break;
        case "reasoning":
          break;
        case "tool-call":
          if (!json) process.stderr.write(`\n[tool] ${event.name} ${JSON.stringify(event.args)}\n`);
          break;
        case "tool-result": {
          if (!json) {
            const preview =
              event.content.length > 500
                ? `${event.content.slice(0, 500)}... (truncated)`
                : event.content;
            process.stderr.write(`[result] ${event.isError ? "ERROR: " : ""}${preview}\n`);
          }
          break;
        }
        case "finish":
          usage.add(event.usage);
          // A resumed session (-c/-r -p) must accumulate this turn's usage,
          // same as the REPL does; plain print runs have no store.
          if (event.usage) {
            sessionStore?.addUsage(event.usage).catch(() => {});
          }
          break;
        case "retry": {
          if (!json) {
            const wait =
              event.delayMs !== undefined && event.delayMs >= 1000
                ? ` in ${Math.round(event.delayMs / 1000)}s`
                : "";
            process.stderr.write(
              `\n[retry ${event.attempt}/${event.maxAttempts}${wait}] ${event.reason}\n`,
            );
          }
          break;
        }
        case "notice":
          if (!json) process.stderr.write(`\n[notice] ${event.message}\n`);
          break;
        case "error":
          if (!json) process.stderr.write(`\n[error] ${formatStreamError(event.error)}\n`);
          exitCode = 1;
          break;
      }
      if (exitCode !== 0) break;
    }
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      const message = error instanceof Error ? formatStreamError(error) : String(error);
      process.stderr.write(`\n[error] ${message}\n`);
      exitCode = 1;
    }
  }
  const usageLine = usage.toJsonLine();
  if (usageLine) {
    if (json) {
      process.stdout.write(`${usageLine}\n`);
    } else {
      const t = usage.totals;
      process.stderr.write(
        `[usage] ${t.requests} requests, ${t.promptTokens} prompt + ${t.completionTokens} completion = ${t.totalTokens} tokens\n`,
      );
    }
  }
  if (!json) process.stdout.write("\n");
  const killedShells = defaultTaskManager.cleanup();
  const killedAgents = defaultAgentTasks.cleanup();
  const stopped = killedShells.length + killedAgents.length;
  if (stopped > 0) {
    process.stderr.write(
      `[info] ${stopped} background task(s) were still running and have been stopped.\n`,
    );
  }
  return exitCode;
}

const program = new Command();

program
  .name("star")
  .description("Star CLI — an AI agent command-line interface")
  .version(VERSION)
  .option("-m, --model <model>", "model to use")
  .option("--permission-mode <mode>", "permission mode: ask | auto | readonly | yolo | plan")
  .option("-p, --print <prompt>", "non-interactive print mode")
  .option("--json", "output NDJSON events on stdout (print mode only)")
  .option(
    "--image <path>",
    "attach an image file (png/jpg/jpeg/gif/webp, max 5MB); repeatable",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("-r, --resume [sessionId]", "resume a previous session (lists sessions when no id given)")
  .option("-c, --continue", "continue the most recent session for the current directory")
  .option(
    "--clear-sessions [scope]",
    "delete stored sessions for the current directory ('all' deletes every session) and exit",
  )
  .action(async (opts) => {
    const cwd = process.cwd();

    if (opts.json && opts.print === undefined) {
      console.error(
        '--json requires print mode: use star -p "..." --json (the interactive REPL does not support JSON output).',
      );
      process.exit(1);
    }

    if (opts.resume !== undefined && opts.continue) {
      console.error("Options --resume and --continue are mutually exclusive: pick one.");
      process.exit(1);
    }

    if (opts.resume === true) {
      const entries = await listSessionEntries(cwd);
      if (entries.length === 0) {
        console.error("No sessions found for this directory.");
      } else {
        console.log(formatSessionEntries(entries));
      }
      process.exit(0);
    }

    if (opts.clearSessions !== undefined) {
      const scope = opts.clearSessions;
      if (scope !== true && scope !== "all") {
        console.error(`Invalid scope: ${scope}. Use --clear-sessions or --clear-sessions all.`);
        process.exit(1);
      }
      const all = scope === "all";
      const removed = await clearSessions(all ? undefined : cwd);
      console.log(
        all
          ? `Deleted ${removed} session(s) across all directories.`
          : `Deleted ${removed} session(s) for this directory.`,
      );
      process.exit(0);
    }

    let config: StarConfig;
    try {
      config = loadConfigSync(cwd, { model: opts.model, permissionMode: opts.permissionMode });
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }

    const modelName = opts.model ?? config.defaultModel;
    if (!modelName) {
      console.error(
        "No model configured. Add one to ~/.star-cli/config.toml or pass --model.\n" +
          "See README.md for configuration examples.",
      );
      process.exit(1);
    }

    let sessionStore: SessionStore | null = null;
    let resumed: { meta: SessionMeta; messages: CoreMessage[] } | null = null;
    let resumeId: string | null = null;
    if (typeof opts.resume === "string") {
      resumeId = await resolveSessionId(opts.resume);
      if (!resumeId) {
        console.error(`Session not found: ${opts.resume}`);
        process.exit(1);
      }
    } else if (opts.continue) {
      const latest = await findLatestSession(cwd);
      if (latest) {
        resumeId = latest.id;
      } else {
        process.stderr.write("No previous session for this directory — starting a new session.\n");
      }
    }

    if (resumeId) {
      // Open the store once and read through it: resumeSession() would open a
      // second SessionStore instance on the same directory whose independent
      // meta cache could race this instance's writes.
      sessionStore = await SessionStore.open(resumeId);
      if (!sessionStore) {
        console.error(`Session not found: ${resumeId}`);
        process.exit(1);
      }
      const [meta, loaded] = await Promise.all([sessionStore.meta(), sessionStore.messages()]);
      const messages = reconcileToolCalls(loaded);
      if (messages.length !== loaded.length) {
        await sessionStore.replaceMessages(messages);
      }
      resumed = { meta, messages };
    } else if (!opts.print) {
      sessionStore = await SessionStore.create(cwd, modelName);
    }

    let loop: AgentLoop;
    try {
      loop = await createLoop(config, modelName, cwd, sessionStore);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    if (resumed) {
      await loop.loadMessages(resumed.messages);
      // Resuming explicitly continues the project: rehydrate its todo list
      // (fresh sessions leave it alone even when .star/todos.json exists).
      await loadTodos(cwd);
      if (sessionStore) {
        hydrateSnapshots(await loadSessionSnapshots(sessionStore.dir));
      }
    }

    if (opts.print) {
      // Let the loop drain instead of process.exit(): force-exiting on Windows
      // can hit a libuv assertion while undici keep-alive handles are closing.
      process.exitCode = await printMode(
        loop,
        opts.print,
        cwd,
        Boolean(opts.json),
        opts.image ?? [],
        sessionStore,
      );
      return;
    }

    renderRepl(loop, {
      model: modelName,
      permissionMode: config.permissionMode,
      config,
      cwd,
      sessionStore,
      initialMessages: resumed?.messages,
      initialUsage: resumed?.meta.usage,
    });
  });

program.parse(process.argv);
