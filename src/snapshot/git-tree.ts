import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitTreesDir } from "../config/paths";
import { isSensitivePath } from "../core/sensitive";

const GIT_TIMEOUT_MS = 10_000;
// gc repacks the object store and legitimately takes longer than the budget
// every other git invocation gets; it runs rarely, so it can afford to wait.
const GC_TIMEOUT_MS = 60_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;
// `git gc --auto` runs after this many successful tree captures per repo
// (each capture adds a tree plus blobs, and nothing else ever prunes them).
const GC_INTERVAL = 50;
// The agent loop calls trackTree at the start of every turn; without a
// negative cache a directory whose tracking fails (huge tree hitting the git
// timeout, unreadable repo) would burn that timeout on every single turn.
const TRACK_FAILURE_TTL_MS = 5 * 60 * 1000;

// Likely-secret files that must never enter the internal snapshot repos,
// pinned into each repo's info/exclude so `git add -A` skips them even in
// projects with no .gitignore and `git clean -fd` on restore leaves them
// alone. Mirrors isSensitivePath (src/core/sensitive.ts), including the
// template exemptions.
const SENSITIVE_EXCLUDE_PATTERNS = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".pgpass",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "**/.aws/credentials",
  "**/.kube/config",
];

// Every git invocation goes through here: array arguments (never a shell), a
// per-call timeout, and any failure — git missing, repo corrupt, timeout —
// resolves null so the snapshot feature degrades silently instead of breaking
// the agent loop.
function runGit(args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { timeout: timeoutMs, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (error, stdout) => {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

let gitAvailable: boolean | null = null;

// Expiry timestamps (Date.now) of the per-directory failure negative cache.
const trackFailureUntil = new Map<string, number>();
// Successful captures per repo since process start, driving the periodic gc.
const trackCounts = new Map<string, number>();
// Repos whose index was already scrubbed of excluded entries this process.
const scrubbedRepos = new Set<string>();

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

// Test hook: drop every piece of cached state (availability probe, failure
// negative cache, gc counters, scrub bookkeeping).
export function resetGitTreeCaches(): void {
  gitAvailable = null;
  trackFailureUntil.clear();
  trackCounts.clear();
  scrubbedRepos.clear();
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
  try {
    // Owner-only like the session directories: tree objects hold file
    // contents the user never committed anywhere else.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(path.join(dir, "HEAD"))) {
      const out = await runGit(["init", "--bare", dir]);
      if (out === null) return null;
    }
    // Rewritten on every call: repos created before the exclusion existed
    // pick it up here without any migration step.
    await mkdir(path.join(dir, "info"), { recursive: true });
    await writeFile(
      path.join(dir, "info", "exclude"),
      `${SENSITIVE_EXCLUDE_PATTERNS.join("\n")}\n`,
      "utf8",
    );
  } catch {
    return null;
  }
  return dir;
}

function repoArgs(dir: string, cwd: string): string[] {
  return [`--git-dir=${dir}`, `--work-tree=${cwd}`];
}

// Drops index entries that match the exclude rules. Ignore patterns only keep
// untracked files out of `git add`; a path already in the index — tracked by
// a pre-exclusion star, or put back by read-tree of an old tree — stays until
// explicitly removed, so both trackTree and restoreTree scrub it.
async function untrackExcluded(dir: string, cwd: string): Promise<boolean> {
  const base = repoArgs(dir, cwd);
  const listed = await runGit([...base, "ls-files", "-z", "-c", "-i", "--exclude-standard"]);
  if (listed === null) return false;
  const files = listed.split("\0").filter(Boolean);
  if (files.length === 0) return true;
  const removed = await runGit([
    ...base,
    "rm",
    "--cached",
    "--ignore-unmatch",
    "-q",
    "--",
    ...files.map((file) => `:(literal)${file}`),
  ]);
  return removed !== null;
}

// Captures the whole working tree (any change — write_file, edit_file, bash)
// as a git tree object and returns its hash. The work tree's own .git is
// skipped by git automatically; ignored files (node_modules) and excluded
// likely-secret files never enter the tree, which is exactly what the restore
// side relies on. A recent failure makes further attempts no-ops until
// TRACK_FAILURE_TTL_MS has passed.
export async function trackTree(cwd: string): Promise<string | null> {
  if (isGuardedDir(cwd)) return null;
  const key = path.resolve(cwd);
  const failedUntil = trackFailureUntil.get(key);
  if (failedUntil !== undefined && Date.now() < failedUntil) return null;
  const tree = await trackTreeUncached(cwd);
  if (tree === null) {
    trackFailureUntil.set(key, Date.now() + TRACK_FAILURE_TTL_MS);
    return null;
  }
  trackFailureUntil.delete(key);
  return tree;
}

async function trackTreeUncached(cwd: string): Promise<string | null> {
  if (!(await isGitAvailable())) return null;
  const dir = await ensureTreeRepo(cwd);
  if (!dir) return null;
  const base = repoArgs(dir, cwd);
  if (!scrubbedRepos.has(dir)) {
    if (!(await untrackExcluded(dir, cwd))) return null;
    scrubbedRepos.add(dir);
  }
  if ((await runGit([...base, "add", "-A"])) === null) return null;
  const tree = await runGit([...base, "write-tree"]);
  if (tree === null) return null;
  const count = (trackCounts.get(dir) ?? 0) + 1;
  trackCounts.set(dir, count);
  if (count % GC_INTERVAL === 0) {
    // Pure housekeeping: the result is ignored so a gc failure never fails
    // the turn, matching the module's silent-degradation style.
    await runGit([`--git-dir=${dir}`, "gc", "--auto"], GC_TIMEOUT_MS);
  }
  return tree;
}

// Restores the working tree to a captured tree: index reset to the tree,
// every index file checked out over the work tree, then untracked
// (post-snapshot) files cleaned. `clean` keeps ignored files, so dependencies
// and excluded secrets survive. checkout-index -a only writes paths present
// in the index, so scrubbing excluded entries after read-tree guarantees a
// tree captured before the exclusion existed still cannot overwrite the
// user's current .env (or delete it via clean, which also skips it).
export async function restoreTree(cwd: string, hash: string): Promise<boolean> {
  if (isGuardedDir(cwd)) return false;
  if (!(await isGitAvailable())) return false;
  const dir = await ensureTreeRepo(cwd);
  if (!dir) return false;
  const base = repoArgs(dir, cwd);
  if ((await runGit([...base, "read-tree", hash])) === null) return false;
  if (!(await untrackExcluded(dir, cwd))) return false;
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
    // Restore never touches excluded likely-secret paths (trees captured
    // before the exclusion may still list them); keep the preview honest.
    if (line !== "" && !isSensitivePath(line)) names.add(line);
  }
  return [...names];
}
