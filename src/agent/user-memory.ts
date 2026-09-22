import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { starHome, userMemoryPath } from "../config/paths";
import type { Tool, ToolResult } from "../tools/types";

export const USER_MEMORY_MAX_CHARS = 32 * 1024;
export const REMEMBER_TEXT_MAX_CHARS = 500;

interface CacheEntry {
  mtimeMs: number;
  block: string | null;
}

const cache = new Map<string, CacheEntry>();

// Reads <home>/MEMORY.md as user long-term memory for the system prompt,
// mirroring readProjectMemory: a delimited block, or null when the file is
// missing, unreadable, or empty. Content is cached by path and re-read only
// when the mtime changes, so appends via the remember tool self-invalidate.
export function readUserMemory(home: string = starHome()): string | null {
  const file = path.join(home, "MEMORY.md");
  let mtimeMs: number;
  try {
    mtimeMs = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.block;

  let block: string | null = null;
  try {
    let body = readFileSync(file, "utf8").trim();
    if (body) {
      if (body.length > USER_MEMORY_MAX_CHARS) {
        body = `${body.slice(0, USER_MEMORY_MAX_CHARS)}\n\n[MEMORY.md truncated to ${USER_MEMORY_MAX_CHARS} characters]`;
      }
      block = [
        "# User memory (MEMORY.md)",
        "The following notes were saved by the user across sessions. Respect them unless they conflict with the current request.",
        body,
      ].join("\n");
    }
  } catch {
    block = null;
  }
  cache.set(file, { mtimeMs, block });
  return block;
}

// Appends one bullet line to the memory file, creating it (and the home
// directory) when missing. The mtime-keyed cache picks the change up on the
// next read.
export function appendUserMemory(text: string, home: string = starHome()): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(path.join(home, "MEMORY.md"), `- ${text}\n`, "utf8");
}

export function createRememberTool(deps: { home?: string } = {}): Tool {
  return {
    name: "remember",
    description: `Save a note to the user's long-term memory (${userMemoryPath()}), injected into every future session. ONLY use when the user explicitly asks to remember or save something. Never use autonomously.`,
    permission: "write",
    parameters: z.object({
      text: z
        .string()
        .max(REMEMBER_TEXT_MAX_CHARS)
        .describe("The note to save, as a single concise sentence."),
    }),
    async execute(args): Promise<ToolResult> {
      appendUserMemory(args.text, deps.home);
      return { content: `Saved to user memory: ${args.text}` };
    },
  };
}
