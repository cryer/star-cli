import { readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export interface WalkedFile {
  abs: string;
  rel: string;
  mtimeMs: number;
}

export type IgnorePredicate = (absPath: string, isDir: boolean) => boolean;

export interface WalkOptions {
  ignore?: IgnorePredicate;
  // Defaults to true. Pass false when the caller does not sort by mtime (e.g.
  // grep) to skip one stat syscall per file; mtimeMs is then reported as 0.
  withMtime?: boolean;
}

export async function walkFiles(
  root: string,
  skipDirs: Set<string> = SKIP_DIRS,
  options: WalkOptions = {},
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function walk(dir: string, relBase: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name) || options.ignore?.(abs, true)) {
          continue;
        }
        await walk(abs, rel);
      } else if (entry.isFile()) {
        if (options.ignore?.(abs, false)) {
          continue;
        }
        if (options.withMtime === false) {
          out.push({ abs, rel, mtimeMs: 0 });
          continue;
        }
        try {
          const st = await stat(abs);
          out.push({ abs, rel, mtimeMs: st.mtimeMs });
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  await walk(root, "");
  return out;
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
