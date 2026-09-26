import { execFileSync } from "node:child_process";

const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export const COMMIT_DIFF_MAX_LINES = 2000;
export const WORKING_DIFF_MAX_LINES = 2000;

// Synchronous by design: callers (system-prompt sync, slash commands) need the
// result inline. Every failure — not a repo, git missing, timeout, oversized
// output — returns null so the agent can never crash on git state.
export function runGit(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.replace(/\n$/, "");
  } catch {
    return null;
  }
}

export function isGitRepo(cwd: string): boolean {
  return runGit(["rev-parse", "--is-inside-work-tree"], cwd) === "true";
}

export interface GitSummary {
  branch: string;
  dirtyCount: number;
  recentCommits: string[];
}

export function getGitSummary(cwd: string): GitSummary | null {
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (branch === null) return null;
  const status = runGit(["status", "--porcelain"], cwd) ?? "";
  const dirtyCount = status === "" ? 0 : status.split("\n").length;
  const log = runGit(["log", "--oneline", "-3"], cwd) ?? "";
  return { branch, dirtyCount, recentCommits: log === "" ? [] : log.split("\n") };
}

const GIT_SUMMARY_CACHE_TTL_MS = 15_000;

const gitSummaryCache = new Map<string, { at: number; summary: GitSummary | null }>();

// System-prompt sync calls getGitSummary every turn — in every loop, including
// each subagent's — and the underlying sync git calls block the event loop for
// up to the 2s timeout, so summaries are cached per cwd for a short TTL.
// Failures (null) are cached too: a plain directory rarely turns into a repo
// within 15s, and re-probing one every turn is the common case outside repos.
export function getGitSummaryCached(cwd: string): GitSummary | null {
  const now = Date.now();
  const hit = gitSummaryCache.get(cwd);
  if (hit && now - hit.at < GIT_SUMMARY_CACHE_TTL_MS) return hit.summary;
  const summary = getGitSummary(cwd);
  gitSummaryCache.set(cwd, { at: now, summary });
  return summary;
}

// Test hook: drop all cached summaries so the next call shells out to git.
export function resetGitSummaryCache(): void {
  gitSummaryCache.clear();
}

export function formatGitSummary(summary: GitSummary): string {
  const lines = [
    "Git context for the working directory (refreshed each turn):",
    `Branch: ${summary.branch}`,
    summary.dirtyCount === 0
      ? "Working tree: clean"
      : `Working tree: ${summary.dirtyCount} file(s) with uncommitted changes`,
  ];
  if (summary.recentCommits.length > 0) {
    lines.push("Recent commits:", ...summary.recentCommits);
  }
  return lines.join("\n");
}

export function truncateLines(
  text: string,
  maxLines: number,
): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function collectDiffs(cwd: string): { staged: string; unstaged: string } {
  return {
    staged: runGit(["diff", "--cached"], cwd) ?? "",
    unstaged: runGit(["diff"], cwd) ?? "",
  };
}

export interface CommitContext {
  status: string;
  diff: string;
  diffTruncated: boolean;
  recentLog: string;
}

// null means nothing to commit (clean tree). Untracked files still count:
// they show up in the status even though `git diff` has no output for them.
export function collectCommitContext(cwd: string): CommitContext | null {
  if (!isGitRepo(cwd)) return null;
  const status = runGit(["status", "--short"], cwd) ?? "";
  const { staged, unstaged } = collectDiffs(cwd);
  if (status === "" && staged === "" && unstaged === "") return null;
  const rawDiff = [staged, unstaged].filter((part) => part !== "").join("\n");
  const { text: diff, truncated } = truncateLines(rawDiff, COMMIT_DIFF_MAX_LINES);
  const recentLog = runGit(["log", "--oneline", "-5"], cwd) ?? "";
  return { status, diff, diffTruncated: truncated, recentLog };
}

export function buildCommitPrompt(context: CommitContext, instructions = ""): string {
  const parts = [
    "Analyze the uncommitted git changes below and create a commit for them.",
    "",
    "Requirements:",
    "- Draft a commit message in Conventional Commits style (e.g. `feat(scope): summary`), consistent with the repository's recent commit history.",
    "- Stage the relevant files and create the commit with the bash tool (`git add` + `git commit`), through the normal permission flow.",
    "- Do not push and do not amend existing commits.",
    "- After committing, briefly report the commit hash and message.",
  ];
  if (instructions) {
    parts.push("", `Additional instructions from the user: ${instructions}`);
  }
  parts.push("", "## git status --short", "```", context.status || "(clean)", "```");
  if (context.recentLog) {
    parts.push("", "## recent commits (git log --oneline -5)", "```", context.recentLog, "```");
  }
  if (context.diff) {
    parts.push("", "## git diff (staged + unstaged)", "```diff", context.diff, "```");
    if (context.diffTruncated) {
      parts.push(`(diff truncated to ${COMMIT_DIFF_MAX_LINES} lines)`);
    }
  }
  return parts.join("\n");
}

export interface WorkingDiff {
  status: string;
  diff: string;
  truncated: boolean;
}

export function collectWorkingDiff(cwd: string): WorkingDiff | null {
  if (!isGitRepo(cwd)) return null;
  const status = runGit(["status", "--short"], cwd) ?? "";
  const { staged, unstaged } = collectDiffs(cwd);
  const sections: string[] = [];
  if (staged) sections.push(`# Staged changes\n${staged}`);
  if (unstaged) sections.push(`# Unstaged changes\n${unstaged}`);
  const { text, truncated } = truncateLines(sections.join("\n"), WORKING_DIFF_MAX_LINES);
  return { status, diff: text, truncated };
}
