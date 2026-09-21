import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBuiltinCommands } from "../src/cli/commands/builtin";
import { type CommandContext, CommandRegistry } from "../src/cli/commands/registry";
import { type DiffLine, parseGitDiffLines } from "../src/cli/diff-preview";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function initRepo(dir: string): void {
  git(["-c", "init.defaultBranch=main", "init"], dir);
  git(["config", "user.email", "star-test@example.com"], dir);
  git(["config", "user.name", "Star Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  git(["add", "a.txt"], dir);
  git(["commit", "-m", "chore: initial commit"], dir);
}

interface Call {
  type: string;
  text?: string;
  lines?: DiffLine[];
  note?: string;
}

function makeCtx(overrides: Partial<CommandContext> = {}) {
  const calls: Call[] = [];
  const ctx: CommandContext = {
    addSystemMessage: (text) => calls.push({ type: "system", text }),
    clearMessages: () => calls.push({ type: "clear" }),
    exit: () => calls.push({ type: "exit" }),
    listModels: () => "models list",
    switchModel: async (name) => `switched to ${name}`,
    listSessions: async () => "sessions list",
    resumeSession: async (id) => `resumed ${id}`,
    showTodos: async () => "todos",
    listTasks: () => "tasks list",
    showUsage: () => "usage",
    showGlobalUsage: async () => "global usage dashboard",
    describeConfig: () => "config summary",
    compactContext: async () => "compact result",
    exportSession: async (p) => `exported ${p}`,
    undo: async () => "undo result",
    rewind: async () => "checkpoint list",
    permissionMode: async (args) => (args ? `mode set ${args}` : "mode list"),
    planMode: async () => "plan toggled",
    initProject: async (args) => `init ${args}`,
    runDoctor: async () => "doctor report",
    submitPrompt: (text) => {
      calls.push({ type: "prompt", text });
    },
    showDiff: (text, lines, note) => {
      calls.push({ type: "diff", text, lines, note });
    },
    ...overrides,
  };
  return { ctx, calls };
}

function makeRegistry() {
  const registry = new CommandRegistry();
  registerBuiltinCommands(registry);
  return registry;
}

describe("parseGitDiffLines", () => {
  it("maps diff line prefixes to render kinds and strips sigils", () => {
    const lines = parseGitDiffLines(
      [
        "diff --git a/a.txt b/a.txt",
        "index 111..222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1,2 @@",
        " one",
        "+two",
        "-old",
      ].join("\n"),
    );
    expect(lines).toEqual([
      { kind: "marker", text: "diff --git a/a.txt b/a.txt" },
      { kind: "marker", text: "index 111..222 100644" },
      { kind: "marker", text: "--- a/a.txt" },
      { kind: "marker", text: "+++ b/a.txt" },
      { kind: "marker", text: "@@ -1 +1,2 @@" },
      { kind: "context", text: "one" },
      { kind: "add", text: "two" },
      { kind: "del", text: "old" },
    ]);
  });
});

describe("/commit", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "star-commit-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a friendly message outside a git repository", async () => {
    const { ctx, calls } = makeCtx({ cwd: dir });
    await makeRegistry().get("commit")?.run("", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("system");
    expect(calls[0]?.text).toContain("not a git repository");
  });

  it("gives a friendly message when the working tree is clean", async () => {
    initRepo(dir);
    const { ctx, calls } = makeCtx({ cwd: dir });
    await makeRegistry().get("commit")?.run("", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("nothing to commit");
  });

  it("submits a commit prompt with status, diff, and log when there are changes", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    const { ctx, calls } = makeCtx({ cwd: dir });

    await makeRegistry().get("commit")?.run("tidy message", ctx);

    expect(calls).toHaveLength(1);
    const prompt = calls[0];
    expect(prompt?.type).toBe("prompt");
    expect(prompt?.text).toContain("Conventional Commits");
    expect(prompt?.text).toContain("a.txt");
    expect(prompt?.text).toContain("+two");
    expect(prompt?.text).toContain("chore: initial commit");
    expect(prompt?.text).toContain("tidy message");
  });

  it("falls back to a system message when the context cannot submit prompts", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    const { ctx, calls } = makeCtx({ cwd: dir, submitPrompt: undefined });

    await makeRegistry().get("commit")?.run("", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("system");
    expect(calls[0]?.text).toContain("cannot submit prompts");
  });
});

describe("/diff", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "star-diff-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("gives a friendly message outside a git repository", async () => {
    const { ctx, calls } = makeCtx({ cwd: dir });
    await makeRegistry().get("diff")?.run("", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("not a git repository");
  });

  it("reports a clean working tree", async () => {
    initRepo(dir);
    const { ctx, calls } = makeCtx({ cwd: dir });
    await makeRegistry().get("diff")?.run("", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("Working tree clean");
  });

  it("renders status and colored diff lines for tracked modifications", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    const { ctx, calls } = makeCtx({ cwd: dir });

    await makeRegistry().get("diff")?.run("", ctx);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.type).toBe("diff");
    expect(call?.text).toContain("git status --short");
    expect(call?.text).toContain("a.txt");
    expect(call?.lines).toContainEqual({ kind: "add", text: "two" });
    expect(call?.lines?.some((line) => line.kind === "marker")).toBe(true);
  });

  it("shows status only when the changes are untracked files", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "new.txt"), "brand new\n");
    const { ctx, calls } = makeCtx({ cwd: dir });

    await makeRegistry().get("diff")?.run("", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("system");
    expect(calls[0]?.text).toContain("?? new.txt");
    expect(calls[0]?.text).toContain("untracked");
  });

  it("falls back to plain text when the context has no diff renderer", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
    const { ctx, calls } = makeCtx({ cwd: dir, showDiff: undefined });

    await makeRegistry().get("diff")?.run("", ctx);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.type).toBe("system");
    expect(calls[0]?.text).toContain("+two");
  });
});
