import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LanguageModelV1Prompt } from "ai";
import { MockLanguageModelV1, convertArrayToReadableStream } from "ai/test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLoop } from "../src/agent/loop";
import type { StarConfig } from "../src/config/schema";
import type { StreamEvent } from "../src/core/events";
import {
  buildCommitPrompt,
  collectCommitContext,
  collectWorkingDiff,
  formatGitSummary,
  getGitSummary,
  getGitSummaryCached,
  isGitRepo,
  resetGitSummaryCache,
  truncateLines,
} from "../src/core/git";
import { createDefaultRegistry } from "../src/tools";

function git(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
}

function initRepo(dir: string): void {
  git(["-c", "init.defaultBranch=main", "init"], dir);
  git(["config", "user.email", "star-test@example.com"], dir);
  git(["config", "user.name", "Star Test"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
}

function commitFile(dir: string, name: string, content: string, message: string): void {
  writeFileSync(path.join(dir, name), content);
  git(["add", name], dir);
  git(["commit", "-m", message], dir);
}

function makeConfig(overrides: Partial<StarConfig> = {}): StarConfig {
  return {
    defaultModel: "test",
    permissionMode: "auto",
    providers: [],
    models: [],
    maxSteps: 50,
    contextMaxTokens: 100_000,
    contextCompaction: "summary",
    streamIdleTimeoutSec: 20,
    streamFirstChunkTimeoutSec: 300,
    streamMaxRetries: 3,
    maxAutoContinues: 2,
    notifyBell: true,
    notifyBellThresholdSec: 10,
    permissions: { allow: [], deny: [], ask: [], sensitive: [] },
    hooks: [],
    doomLoopThreshold: 3,
    gitSnapshots: false,
    webFetchAllowPrivateHosts: false,
    ...overrides,
  };
}

function textModel(text: string): MockLanguageModelV1 {
  return new MockLanguageModelV1({
    doStream: async () => ({
      stream: convertArrayToReadableStream([
        { type: "text-delta", textDelta: text },
        {
          type: "finish",
          finishReason: "stop",
          usage: { promptTokens: 5, completionTokens: 3 },
        },
      ]),
      rawCall: { rawPrompt: null, rawSettings: {} },
    }),
  });
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _ of gen) {
    // exhaust the generator so the turn completes
  }
}

describe("git helpers", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "star-git-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("isGitRepo is false outside a repo and true inside one (including subdirs)", () => {
    expect(isGitRepo(dir)).toBe(false);
    initRepo(dir);
    expect(isGitRepo(dir)).toBe(true);
    const sub = path.join(dir, "nested", "deeper");
    mkdirSync(sub, { recursive: true });
    expect(isGitRepo(sub)).toBe(true);
  });

  it("getGitSummary returns null outside a repo", () => {
    expect(getGitSummary(dir)).toBeNull();
  });

  it("getGitSummary reports branch, dirty count, and recent commits", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    commitFile(dir, "b.txt", "two", "feat: add b");

    const clean = getGitSummary(dir);
    expect(clean?.branch).toBe("main");
    expect(clean?.dirtyCount).toBe(0);
    expect(clean?.recentCommits).toHaveLength(2);
    expect(clean?.recentCommits[0]).toContain("feat: add b");

    writeFileSync(path.join(dir, "a.txt"), "changed");
    writeFileSync(path.join(dir, "untracked.txt"), "new");
    const dirty = getGitSummary(dir);
    expect(dirty?.dirtyCount).toBe(2);
  });

  it("getGitSummaryCached serves the cached summary within the TTL", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    const first = getGitSummaryCached(dir);
    expect(first?.branch).toBe("main");

    // Removing .git makes a fresh probe return null, but the cache still hits.
    rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    expect(getGitSummary(dir)).toBeNull();
    expect(getGitSummaryCached(dir)).toEqual(first);
  });

  it("getGitSummaryCached re-probes after the TTL expires", () => {
    vi.useFakeTimers();
    try {
      initRepo(dir);
      commitFile(dir, "a.txt", "one", "chore: initial commit");
      expect(getGitSummaryCached(dir)).not.toBeNull();

      rmSync(path.join(dir, ".git"), { recursive: true, force: true });
      vi.setSystemTime(Date.now() + 16_000);
      expect(getGitSummaryCached(dir)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("formatGitSummary renders branch and tree state", () => {
    const text = formatGitSummary({
      branch: "main",
      dirtyCount: 3,
      recentCommits: ["abc1234 feat: x"],
    });
    expect(text).toContain("Branch: main");
    expect(text).toContain("3 file(s) with uncommitted changes");
    expect(text).toContain("abc1234 feat: x");
    expect(formatGitSummary({ branch: "main", dirtyCount: 0, recentCommits: [] })).toContain(
      "Working tree: clean",
    );
  });

  it("truncateLines caps output and reports truncation", () => {
    expect(truncateLines("a\nb", 5)).toEqual({ text: "a\nb", truncated: false });
    expect(truncateLines("a\nb\nc", 2)).toEqual({ text: "a\nb", truncated: true });
  });

  it("collectCommitContext returns null when the tree is clean", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    expect(collectCommitContext(dir)).toBeNull();
    expect(collectCommitContext(path.join(dir, "not-a-repo"))).toBeNull();
  });

  it("collectCommitContext gathers status, diff, and recent log", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one\n", "chore: initial commit");
    writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");

    const context = collectCommitContext(dir);
    expect(context).not.toBeNull();
    expect(context?.status).toContain("a.txt");
    expect(context?.diff).toContain("+two");
    expect(context?.diffTruncated).toBe(false);
    expect(context?.recentLog).toContain("chore: initial commit");
  });

  it("collectCommitContext counts untracked files even with an empty diff", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    writeFileSync(path.join(dir, "new.txt"), "brand new");

    const context = collectCommitContext(dir);
    expect(context).not.toBeNull();
    expect(context?.status).toContain("?? new.txt");
    expect(context?.diff).toBe("");
  });

  it("buildCommitPrompt asks for Conventional Commits and embeds the context", () => {
    const prompt = buildCommitPrompt(
      {
        status: " M a.txt",
        diff: "+two",
        diffTruncated: false,
        recentLog: "abc1234 chore: initial commit",
      },
      "keep it short",
    );
    expect(prompt).toContain("Conventional Commits");
    expect(prompt).toContain("git add");
    expect(prompt).toContain("git commit");
    expect(prompt).toContain(" M a.txt");
    expect(prompt).toContain("abc1234 chore: initial commit");
    expect(prompt).toContain("+two");
    expect(prompt).toContain("keep it short");
    expect(prompt).toContain("Do not push");
  });

  it("collectWorkingDiff separates staged and unstaged sections", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one\n", "chore: initial commit");
    commitFile(dir, "b.txt", "x\n", "chore: add b");
    writeFileSync(path.join(dir, "a.txt"), "one\nstaged\n");
    git(["add", "a.txt"], dir);
    writeFileSync(path.join(dir, "b.txt"), "x\nunstaged\n");

    const result = collectWorkingDiff(dir);
    expect(result?.status).toContain("a.txt");
    expect(result?.status).toContain("b.txt");
    expect(result?.diff).toContain("# Staged changes");
    expect(result?.diff).toContain("+staged");
    expect(result?.diff).toContain("# Unstaged changes");
    expect(result?.diff).toContain("+unstaged");
    expect(result?.truncated).toBe(false);
  });

  it("collectWorkingDiff reports a clean tree as empty status and diff", () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    const result = collectWorkingDiff(dir);
    expect(result?.status).toBe("");
    expect(result?.diff).toBe("");
  });
});

describe("git context in the outgoing request", () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "star-git-loop-test-"));
    // Isolate from the real ~/.star-cli — a developer's MEMORY.md would
    // otherwise leak into the system prompt these tests assert on.
    home = mkdtempSync(path.join(tmpdir(), "star-git-loop-home-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function capturingModel(captured: LanguageModelV1Prompt[]): MockLanguageModelV1 {
    return new MockLanguageModelV1({
      doStream: async (options) => {
        captured.push(options.prompt);
        return {
          stream: convertArrayToReadableStream([
            { type: "text-delta", textDelta: "done" },
            {
              type: "finish",
              finishReason: "stop",
              usage: { promptTokens: 5, completionTokens: 3 },
            },
          ]),
          rawCall: { rawPrompt: null, rawSettings: {} },
        };
      },
    });
  }

  function lastUserText(prompt: LanguageModelV1Prompt): string {
    const user = [...prompt].reverse().find((m) => m.role === "user");
    if (!user || typeof user.content === "string") return "";
    return user.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }

  function makeLoop(cwd: string, model?: MockLanguageModelV1): AgentLoop {
    return new AgentLoop({
      model: model ?? textModel("done"),
      registry: createDefaultRegistry(),
      config: makeConfig(),
      cwd,
      system: "BASE PROMPT",
    });
  }

  it("leaves the system prompt untouched outside a git repository", async () => {
    const loop = makeLoop(dir);
    await drain(loop.stream("hi", new AbortController().signal));
    expect(loop.getMessages()[0]?.content).toBe("BASE PROMPT");
  });

  it("sends git state as a request-scoped reminder, keeping the system prompt stable", async () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    const prompts: LanguageModelV1Prompt[] = [];
    const loop = makeLoop(dir, capturingModel(prompts));

    await drain(loop.stream("hi", new AbortController().signal));
    // The system message must not carry volatile git state: it is the head of
    // the prompt-cache prefix, so a changed repo state would invalidate
    // everything after it.
    const head = loop.getMessages()[0];
    expect(head?.role).toBe("system");
    expect(head?.content).toBe("BASE PROMPT");
    const requestText = lastUserText(prompts[0] ?? []);
    expect(requestText).toContain("<system-reminder>");
    expect(requestText).toContain("Branch: main");
    expect(requestText).toContain("Working tree: clean");
    expect(requestText).toContain("chore: initial commit");
    expect(requestText).toContain("hi");
    // Request-only: the persisted user message stays the bare prompt.
    const persistedUser = loop.getMessages().find((m) => m.role === "user");
    expect(persistedUser?.content).toBe("hi");
  });

  it("refreshes the git context on every turn", async () => {
    initRepo(dir);
    commitFile(dir, "a.txt", "one", "chore: initial commit");
    const prompts: LanguageModelV1Prompt[] = [];
    const loop = makeLoop(dir, capturingModel(prompts));

    await drain(loop.stream("first", new AbortController().signal));
    expect(lastUserText(prompts[0] ?? [])).toContain("Working tree: clean");

    writeFileSync(path.join(dir, "a.txt"), "changed");
    // The loop reads git state through the 15s cached summary; tests reset it
    // to observe a refresh within the same test.
    resetGitSummaryCache();
    await drain(loop.stream("second", new AbortController().signal));
    expect(lastUserText(prompts[1] ?? [])).toContain("1 file(s) with uncommitted changes");
    expect(loop.getMessages()[0]?.content).toBe("BASE PROMPT");
  });
});
