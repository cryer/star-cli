import { readFileSync, statSync } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

// Concurrent readdir/stat lanes during a directory walk; large trees are
// latency-bound on syscalls, so siblings are explored in parallel.
export const WALK_CONCURRENCY = 16;

export interface WalkedFile {
  abs: string;
  rel: string;
  mtimeMs: number;
  // Realpath of the target when the entry was reached through a symlink or
  // junction; lets callers (grep) apply sensitive-path checks to the target
  // too. Undefined for plain files.
  resolved?: string;
}

export type IgnorePredicate = (absPath: string, isDir: boolean) => boolean;

export interface WalkOptions {
  ignore?: IgnorePredicate;
  // Defaults to true. Pass false when the caller does not sort by mtime (e.g.
  // grep) to skip one stat syscall per file; mtimeMs is then reported as 0.
  withMtime?: boolean;
  // Checked before each directory read and inside the entry loop. On abort
  // the walk stops dispatching new work and returns partial results with
  // `aborted: true`.
  signal?: AbortSignal;
  // Symlink targets are followed only while their realpath stays inside this
  // directory (typically the cwd the permission gate approved); targets
  // resolving outside are skipped so a planted link cannot make a walk leak
  // files the gate would have asked about or denied. Omit to follow links
  // with cycle protection only.
  symlinkBoundary?: string;
  // Load nested .starignore files as the walk enters each directory; their
  // patterns apply gitignore-style to that directory's subtree, resolved
  // relative to the directory holding the file. Presence is detected from
  // the parent's readdir listing, so directories without one cost no extra
  // syscall. Inside a symlinked subtree the rules anchor at the link's walk
  // position (paths stay lexical; the file content comes from the target).
  nestedIgnore?: boolean;
}

export interface WalkResult {
  files: WalkedFile[];
  aborted: boolean;
}

function createLimiter(concurrency: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    while (active >= concurrency) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

// Patterns from one nested .starignore, anchored at the directory holding it.
// relBase is that directory's walk-relative path ("" at the walk root) so
// entries relativize with a slice instead of path.relative per pattern.
interface IgnoreLayer {
  relBase: string;
  patterns: IgnorePattern[];
}

function layerIgnores(layers: IgnoreLayer[], rel: string, isDir: boolean): boolean {
  for (const layer of layers) {
    // A layer only governs its own subtree; entries outside it skip the
    // layer instead of slicing into a bogus relative path.
    const local =
      layer.relBase === ""
        ? rel
        : rel.startsWith(`${layer.relBase}/`)
          ? rel.slice(layer.relBase.length + 1)
          : null;
    if (local === null) {
      continue;
    }
    for (const { pattern, dirOnly } of layer.patterns) {
      if (dirOnly && !isDir) {
        continue;
      }
      if (matchesGlob(pattern, local)) {
        return true;
      }
    }
  }
  return false;
}

export async function walkFiles(
  root: string,
  skipDirs: Set<string> = SKIP_DIRS,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const out: WalkedFile[] = [];
  const limit = createLimiter(WALK_CONCURRENCY);
  const signal = options.signal;
  const caseKey = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  // Realpaths of directories already entered. Only symlink targets can create
  // a cycle (A↔B, link to an ancestor), so real directories are not tracked.
  const visited = new Set<string>();
  const rootReal = await realpath(root).catch(() => null);
  if (rootReal !== null) {
    visited.add(caseKey(rootReal));
  }
  // Resolved lazily on the first symlink so trees without links pay nothing.
  let boundaryReal: string | null | undefined;
  async function resolveLink(abs: string): Promise<string | null> {
    const real = await limit(() => realpath(abs)).catch(() => null);
    if (real === null) {
      return null;
    }
    const boundary = options.symlinkBoundary;
    if (boundary === undefined) {
      return real;
    }
    if (boundaryReal === undefined) {
      boundaryReal = await limit(() => realpath(boundary)).catch(() => null);
    }
    if (boundaryReal === null) {
      // The approved root cannot be resolved: fail closed, like the walk did
      // before links were followed at all.
      return null;
    }
    const realKey = caseKey(real);
    const boundaryKey = caseKey(boundaryReal);
    return realKey === boundaryKey || realKey.startsWith(`${boundaryKey}${path.sep}`) ? real : null;
  }

  async function walkDir(dir: string, relBase: string, parentLayers: IgnoreLayer[]): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const entries = await limit(() => readdir(dir, { withFileTypes: true })).catch(() => null);
    if (!entries) {
      return;
    }
    let layers = parentLayers;
    if (options.nestedIgnore && entries.some((e) => e.name === IGNORE_FILE)) {
      const patterns = loadIgnorePatterns(dir);
      if (patterns.length > 0) {
        layers = [...parentLayers, { relBase, patterns }];
      }
    }
    const subs: Promise<void>[] = [];
    for (const entry of entries) {
      if (signal?.aborted) {
        break;
      }
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      // For a symlink the Dirent describes the link itself; stat() follows to
      // the target. targetStat is reused for the mtime below.
      let targetStat: Awaited<ReturnType<typeof stat>> | null = null;
      let resolved: string | undefined;
      if (entry.isSymbolicLink()) {
        targetStat = await limit(() => stat(abs)).catch(() => null);
        if (!targetStat || (!targetStat.isDirectory() && !targetStat.isFile())) {
          continue;
        }
        const real = await resolveLink(abs);
        if (real === null) {
          continue;
        }
        resolved = real;
        if (targetStat.isDirectory()) {
          const key = caseKey(real);
          if (visited.has(key)) {
            continue;
          }
          visited.add(key);
        }
      }
      const isDir = entry.isDirectory() || (targetStat?.isDirectory() ?? false);
      const isFile = entry.isFile() || (targetStat?.isFile() ?? false);
      if (isDir) {
        if (skipDirs.has(entry.name) || options.ignore?.(abs, true)) {
          continue;
        }
        if (layers.length > 0 && layerIgnores(layers, rel, true)) {
          continue;
        }
        subs.push(walkDir(abs, rel, layers));
      } else if (isFile) {
        if (options.ignore?.(abs, false)) {
          continue;
        }
        if (layers.length > 0 && layerIgnores(layers, rel, false)) {
          continue;
        }
        if (options.withMtime === false) {
          out.push(
            resolved === undefined ? { abs, rel, mtimeMs: 0 } : { abs, rel, mtimeMs: 0, resolved },
          );
          continue;
        }
        const st = targetStat ?? (await limit(() => stat(abs)).catch(() => null));
        if (st) {
          out.push(
            resolved === undefined
              ? { abs, rel, mtimeMs: st.mtimeMs }
              : { abs, rel, mtimeMs: st.mtimeMs, resolved },
          );
        }
      }
    }
    await Promise.all(subs);
  }
  await walkDir(root, "", []);
  // Concurrent pushes arrive in nondeterministic order; sort so grep's match
  // order and truncation cut are stable from run to run.
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files: out, aborted: signal?.aborted ?? false };
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

function escapeRe(c: string): string {
  return c.replace(REGEX_SPECIALS, "\\$&");
}

// Supports *, **, ?, {a,b} braces (nested one level) and [abc] / [!abc]
// character classes. Consecutive `**/` segments are collapsed into a single
// (?:[^/]+/)* so adjacent repetitions cannot produce exponential backtracking.
export function globToRegExp(pattern: string): RegExp {
  let i = 0;

  function parseClass(): string {
    // i points at "["
    let j = i + 1;
    let negate = false;
    if (pattern.charAt(j) === "!") {
      negate = true;
      j += 1;
    }
    let body = "";
    // a "]" right after "[" or "[!" is a literal member of the class
    if (pattern.charAt(j) === "]") {
      body += "\\]";
      j += 1;
    }
    while (j < pattern.length && pattern.charAt(j) !== "]") {
      const ch = pattern.charAt(j);
      body += ch === "\\" ? "\\\\" : ch;
      j += 1;
    }
    if (j < pattern.length) {
      i = j + 1;
      // a leading ^ would negate the regex class; escape it
      if (body.startsWith("^")) body = `\\${body}`;
      return `[${negate ? "^" : ""}${body}]`;
    }
    // unterminated "[": match it literally
    i += 1;
    return "\\[";
  }

  function parseSegment(depth: number): { re: string; end: string } {
    let re = "";
    while (i < pattern.length) {
      const c = pattern.charAt(i);
      if (depth > 0 && (c === "," || c === "}")) {
        return { re, end: c };
      }
      if (c === "*") {
        if (pattern.charAt(i + 1) === "*") {
          i += 2;
          if (pattern.charAt(i) === "/") {
            i += 1;
            re += "(?:[^/]+/)*";
            while (pattern.startsWith("**/", i)) {
              i += 3;
            }
          } else {
            re += ".*";
          }
        } else {
          re += "[^/]*";
          i += 1;
        }
        continue;
      }
      if (c === "?") {
        re += "[^/]";
        i += 1;
        continue;
      }
      if (c === "[") {
        re += parseClass();
        continue;
      }
      if (c === "{" && depth < 2) {
        const close = braceEnd(i);
        if (close === -1) {
          re += "\\{";
          i += 1;
          continue;
        }
        i += 1;
        const alts: string[] = [];
        for (;;) {
          const part = parseSegment(depth + 1);
          alts.push(part.re);
          if (part.end !== ",") break;
          i += 1;
        }
        i += 1; // consume "}"
        re += `(?:${alts.join("|")})`;
        continue;
      }
      re += escapeRe(c);
      i += 1;
    }
    return { re, end: "" };
  }

  function braceEnd(from: number): number {
    let depth = 0;
    for (let j = from; j < pattern.length; j++) {
      const ch = pattern.charAt(j);
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return j;
      }
    }
    return -1;
  }

  const { re } = parseSegment(0);
  return new RegExp(`^${re}$`);
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  const normalized = pattern.replace(/\\/g, "/");
  if (!normalized.includes("/")) {
    const base = relPath.split("/").pop() ?? relPath;
    return globToRegExp(normalized).test(base);
  }
  return globToRegExp(normalized).test(relPath);
}

export const IGNORE_FILE = ".starignore";

export interface IgnorePattern {
  pattern: string;
  dirOnly: boolean;
}

const ignoreCache = new Map<string, { mtimeMs: number; patterns: IgnorePattern[] }>();

function parseIgnorePatterns(body: string): IgnorePattern[] {
  const out: IgnorePattern[] = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.endsWith("/")) {
      const pattern = line.slice(0, -1);
      if (pattern) {
        out.push({ pattern, dirOnly: true });
      }
    } else {
      out.push({ pattern: line, dirOnly: false });
    }
  }
  return out;
}

// Reads <dir>/.starignore. Cached by file path and re-read only when the
// mtime changes, mirroring readProjectMemory in agent/project-memory.ts.
export function loadIgnorePatterns(dir: string): IgnorePattern[] {
  const file = path.join(dir, IGNORE_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const hit = ignoreCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) {
    return hit.patterns;
  }
  let patterns: IgnorePattern[] = [];
  try {
    patterns = parseIgnorePatterns(readFileSync(file, "utf8"));
  } catch {
    patterns = [];
  }
  ignoreCache.set(file, { mtimeMs, patterns });
  return patterns;
}

// Builds an ignore predicate from <cwd>/.starignore, or undefined when there
// are no patterns so callers keep a zero-overhead path. Paths are matched
// relative to cwd with forward slashes; "!" negation is not supported.
export function createIgnorePredicate(cwd: string): IgnorePredicate | undefined {
  const patterns = loadIgnorePatterns(cwd);
  if (patterns.length === 0) {
    return undefined;
  }
  const root = path.resolve(cwd);
  return (absPath, isDir) => {
    const rel = path.relative(root, absPath).split(path.sep).join("/");
    if (!rel || rel.startsWith("..")) {
      return false;
    }
    for (const { pattern, dirOnly } of patterns) {
      if (dirOnly && !isDir) {
        continue;
      }
      if (matchesGlob(pattern, rel)) {
        return true;
      }
    }
    return false;
  };
}

export { isSensitivePath } from "../../core/sensitive";
