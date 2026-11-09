import { statSync } from "node:fs";
import path from "node:path";
import { readContainedTextFile } from "./safe-file";

export const PROJECT_MEMORY_FILE = "AGENTS.md";
export const PROJECT_MEMORY_MAX_CHARS = 32 * 1024;

interface CacheEntry {
  mtimeMs: number;
  block: string | null;
}

const cache = new Map<string, CacheEntry>();

// Reads <cwd>/AGENTS.md as project memory for the system prompt. Returns a
// delimited block, or null when the file is missing, unreadable, or empty.
// Synchronous like the git helpers; content is cached by path and re-read
// only when the mtime changes, so /init regenerations mid-session are
// picked up without a stat+read on every turn beyond a cheap statSync.
export function readProjectMemory(cwd: string): string | null {
  const file = path.join(cwd, PROJECT_MEMORY_FILE);
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.block;

  const safe = readContainedTextFile(cwd, cwd, file, PROJECT_MEMORY_MAX_CHARS);
  let block: string | null = null;
  if (safe) {
    mtimeMs = safe.mtimeMs;
    let body = safe.content.trim();
    if (body) {
      if (body.length > PROJECT_MEMORY_MAX_CHARS) {
        body = `${body.slice(0, PROJECT_MEMORY_MAX_CHARS)}\n\n[AGENTS.md truncated to ${PROJECT_MEMORY_MAX_CHARS} characters]`;
      }
      block = `# Project instructions (AGENTS.md)\n${body}`;
    }
  }
  cache.set(file, { mtimeMs, block });
  return block;
}
