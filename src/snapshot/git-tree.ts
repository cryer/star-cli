import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitTreesDir } from "../config/paths";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

// Every git invocation goes through here: array arguments (never a shell), a
// per-call timeout, and any failure — git missing, repo corrupt, timeout —
// resolves null so the snapshot feature degrades silently instead of breaking
// the agent loop.
function runGit(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (error, stdout) => {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

let gitAvailable: boolean | null = null;

export async function isGitAvailable(): Promise<boolean> {
  if (gitAvailable === null) {
    gitAvailable = (await runGit(["--version"])) !== null;
  }
  return gitAvailable;
}

// Test hook: drop the cached availability probe so a mocked execFile takes
// effect without reloading the module.
export function resetGitTreeAvailability(): void {
  gitAvailable = null;
}

// One internal bare repo per project directory, named by the resolved path so
// two directories never share a tree store.
export function treeRepoDir(cwd: string): string {
  const key = Buffer.from(path.resolve(cwd), "utf8").toString("base64url");
  return path.join(gitTreesDir(), key);
}

// Snapshotting the home directory or a filesystem root would track an entire
// machine — refuse rather than let a stray session there index everything.
function isGuardedDir(cwd: string): boolean {
  const resolved = path.resolve(cwd);
  const home = path.resolve(os.homedir());
  const same = (a: string, b: string) =>
    process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  return same(resolved, home) || same(resolved, path.parse(resolved).root);
}

async function ensureTreeRepo(cwd: string): Promise<string | null> {
  const dir = treeRepoDir(cwd);
  if (existsSync(path.join(dir, "HEAD"))) return dir;
  await mkdir(path.dirname(dir), { recursive: true });
  const out = await runGit(["init", "--bare", dir]);
  return out === null ? null : dir;
}

function repoArgs(dir: string, cwd: string): string[] {
  return [`--git-dir=${dir}`, `--work-tree=${cwd}`];
}

// Captures the whole working tree (any change — write_file, edit_file, bash)
// as a git tree object and returns its hash. The work tree's own .git is
// skipped by git automatically; ignored files (node_modules) never enter the
// tree, which is exactly what the restore side relies on.
export async function trackTree(cwd: string): Promise<string | null> {
  if (isGuardedDir(cwd)) return null;
  if (!(await isGitAvailable())) return null;
  const dir = await ensureTreeRepo(cwd);
  if (!dir) return null;
  const base = repoArgs(dir, cwd);
  if ((await runGit([...base, "add", "-A"])) === null) return null;
  return runGit([...base, "write-tree"]);
}

// Restores the working tree to a captured tree: index reset to the tree,
// every file checked out over the work tree, then untracked (post-snapshot)
// files cleaned. `clean` keeps ignored files, so dependencies survive.
export async function restoreTree(cwd: string, hash: string): Promise<boolean> {
  if (isGuardedDir(cwd)) return false;
  if (!(await isGitAvailable())) return false;
  const dir = treeRepoDir(cwd);
  if (!existsSync(path.join(dir, "HEAD"))) return false;
  const base = repoArgs(dir, cwd);
  if ((await runGit([...base, "read-tree", hash])) === null) return false;
  if ((await runGit([...base, "checkout-index", "-f", "-a"])) === null) return false;
  if ((await runGit([...base, "clean", "-fd"])) === null) return false;
  return true;
}

// Read-only list of files restoring a tree would touch: tracked paths that
// differ from the tree, plus untracked (non-ignored) paths the clean step
// would remove. Backs the /undo and /redo previews.
export async function diffTreeNames(cwd: string, hash: string): Promise<string[] | null> {
  if (!(await isGitAvailable())) return null;
  const dir = treeRepoDir(cwd);
  if (!existsSync(path.join(dir, "HEAD"))) return null;
  const base = repoArgs(dir, cwd);
  const changed = await runGit([...base, "diff", "--name-only", hash]);
  const untracked = await runGit([...base, "ls-files", "--others", "--exclude-standard"]);
  if (changed === null || untracked === null) return null;
  const names = new Set<string>();
  for (const line of [...changed.split("\n"), ...untracked.split("\n")]) {
    if (line !== "") names.add(line);
  }
  return [...names];
}
