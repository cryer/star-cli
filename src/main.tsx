import { Command } from "commander";
import { AgentLoop } from "./agent/loop";
import { renderRepl } from "./cli/repl";
import { loadConfigSync } from "./config/loader";
import type { StarConfig } from "./config/schema";
import type { CoreMessage } from "./core/messages";
import { createModel } from "./llm/provider";
import { resumeSession } from "./session/resume";
import { type SessionMeta, SessionStore } from "./session/store";
import { createDefaultRegistry } from "./tools";

const SYSTEM_PROMPT = `You are Star CLI, an AI coding agent running in the user's terminal.
You help with software engineering tasks: reading, writing and editing code, running shell commands, and managing todos.
Be concise and direct. Use tools when they help accomplish the task.
The working directory is the user's project root; never touch files outside it without explicit instruction.`;

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
  });
}

async function printMode(loop: AgentLoop, prompt: string): Promise<number> {
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  let requests = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let exitCode = 0;
  for await (const event of loop.stream(prompt, controller.signal)) {
    switch (event.type) {
      case "text-delta":
        process.stdout.write(event.text);
        break;
      case "tool-call":
        process.stderr.write(`\n[tool] ${event.name} ${JSON.stringify(event.args)}\n`);
        break;
      case "tool-result": {
        const preview =
          event.content.length > 500
            ? `${event.content.slice(0, 500)}... (truncated)`
            : event.content;
        process.stderr.write(`[result] ${event.isError ? "ERROR: " : ""}${preview}\n`);
        break;
      }
      case "finish":
        if (event.usage) {
          requests += 1;
          promptTokens += event.usage.promptTokens;
          completionTokens += event.usage.completionTokens;
          totalTokens += event.usage.totalTokens;
        }
        break;
      case "error":
        process.stderr.write(`\n[error] ${event.error.message}\n`);
        exitCode = 1;
        break;
    }
    if (exitCode !== 0) break;
  }
  if (requests > 0) {
    process.stderr.write(
      `[usage] ${requests} requests, ${promptTokens} prompt + ${completionTokens} completion = ${totalTokens} tokens\n`,
    );
  }
  process.stdout.write("\n");
  return exitCode;
}

const program = new Command();

program
  .name("star")
  .description("Star CLI — an AI agent command-line interface")
  .version("0.1.0")
  .option("-m, --model <model>", "model to use")
  .option("--permission-mode <mode>", "permission mode: auto | ask | readonly")
  .option("-p, --print <prompt>", "non-interactive print mode")
  .option("-r, --resume <sessionId>", "resume a previous session")
  .action(async (opts) => {
    const cwd = process.cwd();

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
    if (opts.resume) {
      resumed = await resumeSession(opts.resume);
      if (!resumed) {
        console.error(`Session not found: ${opts.resume}`);
        process.exit(1);
      }
      sessionStore = await SessionStore.open(opts.resume);
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
    }

    if (opts.print) {
      const code = await printMode(loop, opts.print);
      process.exit(code);
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
