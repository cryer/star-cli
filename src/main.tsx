import { Command } from "commander";
import { defaultAgentTasks } from "./agent/agent-tasks";
import type { AgentLoop } from "./agent/loop";
import { printMode } from "./cli/print-mode";
import {
  imageRequiresPrintError,
  installStdoutEpipeGuard,
  interactiveRequiresTtyError,
  reportResumeSessions,
} from "./cli/startup";
import { SYSTEM_PROMPT } from "./cli/system-prompt";
import { loadConfigSync } from "./config/loader";
import { type StarConfig, contextWindowTokens } from "./config/schema";
import { type StarMessage, reconcileStarMessages } from "./core/messages";
import { resolveModelConfig, resolveStartupModel } from "./llm/registry";
import { loadSessionSnapshots } from "./session/checkpoints";
import { clearSessions } from "./session/clear";
import { findLatestSession, resolveSessionId } from "./session/list";
import { type SessionMeta, SessionStore } from "./session/store";
import { defaultTaskManager } from "./tasks/manager";
import { hydrateSnapshots } from "./tools/fs/snapshots";
import { loadTodos, setTodoSession } from "./tools/todo";
import { VERSION } from "./version";

async function createLoop(
  config: StarConfig,
  modelName: string,
  cwd: string,
  sessionStore: SessionStore | null,
) {
  // Dynamic like the REPL import below: the agent loop pulls in the ai SDK
  // and every @ai-sdk provider (~100ms of module evaluation) that --version,
  // --help, session listing and --clear-sessions never need.
  const [{ AgentLoop }, { createModel, reasoningEffortMetadata }, { createDefaultRegistry }] =
    await Promise.all([import("./agent/loop"), import("./llm/provider"), import("./tools")]);
  const model = createModel(config, modelName);
  const registry = createDefaultRegistry();
  const modelConfig = resolveModelConfig(config, modelName);
  return new AgentLoop({
    model,
    registry,
    config,
    cwd,
    system: SYSTEM_PROMPT,
    sessionStore,
    modelName,
    contextMaxTokens: contextWindowTokens(config, modelName),
    maxTokens: modelConfig.maxTokens,
    providerMetadata: reasoningEffortMetadata(config, modelName),
    temperature: modelConfig.temperature,
    streamIdleTimeoutSec: modelConfig.streamIdleTimeoutSec,
    streamFirstChunkTimeoutSec: modelConfig.streamFirstChunkTimeoutSec,
    vision: modelConfig.vision,
  });
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

    const imageError = imageRequiresPrintError(opts.print, opts.image ?? []);
    if (imageError) {
      console.error(imageError);
      process.exit(1);
    }

    if (opts.resume !== undefined && opts.continue) {
      console.error("Options --resume and --continue are mutually exclusive: pick one.");
      process.exit(1);
    }

    if (opts.resume === true) {
      process.exit(await reportResumeSessions(cwd));
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

    let sessionStore: SessionStore | null = null;
    let shuttingDown = false;
    installStdoutEpipeGuard(process.stdout, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void (async () => {
        defaultTaskManager.cleanup();
        defaultAgentTasks.cleanup();
        await sessionStore?.close();
        process.exit(0);
      })();
    });
    let resumed: { meta: SessionMeta; messages: StarMessage[] } | null = null;
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
      const [meta, loaded] = await Promise.all([sessionStore.meta(), sessionStore.starMessages()]);
      const messages = reconcileStarMessages(loaded);
      if (messages.length !== loaded.length && !(await sessionStore.replaceMessages(messages))) {
        throw new Error(`Could not repair persisted history for session ${resumeId}`);
      }
      resumed = { meta, messages };
      setTodoSession(resumeId);
    }

    // An explicit --model already landed in config.defaultModel (loader
    // override) and wins; otherwise a resumed session's recorded model is
    // restored when it still resolves in the config.
    const { name: modelName, notice: modelNotice } = resolveStartupModel(
      config,
      opts.model ? undefined : resumed?.meta.model,
    );
    if (modelNotice) {
      process.stderr.write(`${modelNotice}\n`);
    }
    if (!modelName) {
      console.error(
        "No model configured. Add one to ~/.star-cli/config.toml or pass --model.\n" +
          "See README.md for configuration examples.",
      );
      process.exit(1);
    }

    if (!resumeId && opts.print === undefined) {
      sessionStore = await SessionStore.create(cwd, modelName);
      setTodoSession(sessionStore.id);
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
      // (fresh sessions leave it alone even when .star/todos.json exists, and
      // a list owned by another session is not adopted).
      await loadTodos(cwd, resumeId ?? undefined);
      if (sessionStore) {
        hydrateSnapshots(await loadSessionSnapshots(sessionStore.dir));
      }
    }

    if (opts.print !== undefined) {
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

    // The REPL needs a real terminal on both ends; check before paying for
    // the Ink import so a piped launch fails fast with a clear message.
    const ttyError = interactiveRequiresTtyError({
      stdinTTY: Boolean(process.stdin.isTTY),
      stdoutTTY: Boolean(process.stdout.isTTY),
    });
    if (ttyError) {
      console.error(ttyError);
      process.exit(1);
    }

    // The REPL pulls in Ink and every interactive component (~0.4s of module
    // evaluation): load it only on the interactive path so -p, --version,
    // --clear-sessions and session listing stay cheap.
    const { renderRepl } = await import("./cli/repl");
    renderRepl(loop, {
      model: modelName,
      permissionMode: config.permissionMode,
      config,
      cwd,
      sessionStore,
      initialMessages: resumed ? resumed.messages : undefined,
      initialUsage: resumed?.meta.usage,
    });
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
