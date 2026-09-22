import { readdir } from "node:fs/promises";
import path from "node:path";
import { SKIP_DIRS, createIgnorePredicate } from "../tools/fs/util";
import { MAX_SUGGESTIONS } from "./commands/suggest";

// Lazy scan: only the single directory the typed prefix points into is read,
// and no more than this many entries are examined per lookup.
export const MAX_SCAN_ENTRIES = 2000;

export interface AtToken {
  // Path prefix typed after the "@".
  token: string;
  // Index of the "@" in the input value.
  start: number;
  // Cursor position (end of the token).
  end: number;
}

// The "@token" immediately before the cursor: preceded by start-of-input or
// whitespace, with no whitespace inside the token itself.
export function extractAtToken(value: string, cursor: number): AtToken | null {
  const before = value.slice(0, cursor);
  const match = /(?:^|\s)@(\S*)$/.exec(before);
  if (!match) return null;
  const token = match[1] ?? "";
  return { token, start: cursor - token.length - 1, end: cursor };
}

export interface PathSuggestion {
  // Path relative to cwd; directories carry a trailing "/" so Tab descends.
  path: string;
  isDir: boolean;
}

export async function suggestPaths(
  token: string,
  cwd: string,
  maxScanEntries: number = MAX_SCAN_ENTRIES,
  maxSuggestions: number = MAX_SUGGESTIONS,
): Promise<PathSuggestion[]> {
  const normalized = token.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const dirPart = slash >= 0 ? normalized.slice(0, slash + 1) : "";
  const basePrefix = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  if (dirPart.split("/").some((segment) => SKIP_DIRS.has(segment))) return [];
  const dirAbs = path.resolve(cwd, dirPart === "" ? "." : dirPart);
  const entries = await readdir(dirAbs, { withFileTypes: true }).catch(() => null);
  if (!entries) return [];
  const ignore = createIgnorePredicate(cwd);
  const lower = basePrefix.toLowerCase();
  const matches: PathSuggestion[] = [];
  let scanned = 0;
  for (const entry of entries) {
    if (scanned >= maxScanEntries) break;
    scanned += 1;
    const isDir = entry.isDirectory();
    if (!isDir && !entry.isFile()) continue;
    if (isDir && SKIP_DIRS.has(entry.name)) continue;
    if (entry.name.startsWith(".") && !basePrefix.startsWith(".")) continue;
    if (!entry.name.toLowerCase().startsWith(lower)) continue;
    if (ignore?.(path.join(dirAbs, entry.name), isDir)) continue;
    matches.push({ path: `${dirPart}${entry.name}${isDir ? "/" : ""}`, isDir });
  }
  matches.sort((a, b) => a.path.localeCompare(b.path));
  return matches.slice(0, maxSuggestions);
}
