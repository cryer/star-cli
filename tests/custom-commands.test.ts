import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { loadCustomCommands, registerCustomCommands } from "../src/cli/commands/custom";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import { createDefaultRegistry } from "../src/tools";

function makeConfig(): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    permissions: { allow: [] },
  };
}

async function collect(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function writeCommand(dir: string, fileName: string, content: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), content, "utf8");
}

describe("loadCustomCommands", () => {
  let cwd: string;
  let home: string;
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-cmd-project-"));
    home = mkdtempSync(path.join(tmpdir(), "star-cmd-home-"));
    projectDir = path.join(cwd, ".star", "commands");
    globalDir = path.join(home, "commands");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("loads .md files with description from the first-line comment", () => {
    writeCommand(
      projectDir,
      "review.md",
      "<!-- description: Review some code -->\nReview $ARGUMENTS",
    );
    const commands = loadCustomCommands(cwd, home);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      name: "review",
      description: "Review some code",
      template: "Review $ARGUMENTS",
    });
  });

  it("falls back to a default description without a comment", () => {
    writeCommand(projectDir, "plain.md", "Just do the thing");
    const commands = loadCustomCommands(cwd, home);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.description).toBe("Custom prompt command");
    expect(commands[0]?.template).toBe("Just do the thing");
  });

  it("skips files with invalid names and empty templates", () => {
    writeCommand(projectDir, "Bad_Name.md", "nope");
    writeCommand(projectDir, "UPPER.md", "nope");
    writeCommand(projectDir, "empty.md", "<!-- description: nothing -->\n");
    writeCommand(projectDir, "notes.txt", "not markdown");
    writeCommand(projectDir, "good-one.md", "yes");
    const commands = loadCustomCommands(cwd, home);
    expect(commands.map((c) => c.name)).toEqual(["good-one"]);
  });

  it("project commands override global commands with the same name", () => {
    writeCommand(globalDir, "shared.md", "global template");
    writeCommand(projectDir, "shared.md", "project template");
    writeCommand(globalDir, "only-global.md", "global only");
    const commands = loadCustomCommands(cwd, home);
    const byName = new Map(commands.map((c) => [c.name, c]));
    expect(byName.get("shared")?.template).toBe("project template");
    expect(byName.get("only-global")?.template).toBe("global only");
  });

  it("returns nothing when directories do not exist", () => {
    expect(loadCustomCommands(cwd, home)).toEqual([]);
  });
});

describe("registerCustomCommands", () => {
  let cwd: string;
  let home: string;
  let projectDir: string;

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "star-cmd-reg-"));
    home = mkdtempSync(path.join(tmpdir(), "star-cmd-home-"));
    projectDir = path.join(cwd, ".star", "commands");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("builtins win over custom commands with the same name", () => {
    writeCommand(projectDir, "help.md", "custom help takeover");
    writeCommand(projectDir, "mine.md", "mine body");
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const registered = registerCustomCommands(registry, cwd, home);
    expect(registered.map((c) => c.name)).toEqual(["mine"]);
    expect(registry.get("help")?.description).toBe("List available commands");
    expect(registry.get("mine")).toBeDefined();
  });

  it("dispatches with $ARGUMENTS substituted via submitPrompt", async () => {
    writeCommand(
      projectDir,
      "review.md",
      "<!-- description: r -->\nReview this: $ARGUMENTS\nDone.",
    );
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    registerCustomCommands(registry, cwd, home);

    let submitted: string | null = null;
    const ctx = {
      addSystemMessage: () => {},
      submitPrompt: async (text: string) => {
        submitted = text;
      },
    } as unknown as CommandContext;

    await registry.get("review")?.run("src/foo.ts and more", ctx);
    expect(submitted).toBe("Review this: src/foo.ts and more\nDone.");
  });

  it("the model receives the expanded template through an AgentLoop", async () => {
    writeCommand(projectDir, "explain.md", "Explain $ARGUMENTS briefly");
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    registerCustomCommands(registry, cwd, home);

    let capturedPrompt: unknown;
    const model = new MockLanguageModelV1({
      doStream: async (opts) => {
        capturedPrompt = opts.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "ok" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
    const loop = new AgentLoop({
      model,
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
    });

    const ctx = {
      addSystemMessage: () => {},
      submitPrompt: async (text: string) => {
        await collect(loop.stream(text, new AbortController().signal));
      },
    } as unknown as CommandContext;

    await registry.get("explain")?.run("quicksort", ctx);
    expect(JSON.stringify(capturedPrompt)).toContain("Explain quicksort briefly");
  });

  it("custom commands appear alongside builtins in the listing", () => {
    writeCommand(projectDir, "zzz-custom.md", "body");
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    registerCustomCommands(registry, cwd, home);
    const names = registry.list().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("zzz-custom");
    expect(registry.complete("/zzz")[0]?.name).toBe("zzz-custom");
  });
});
