import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { isSensitivePath } from "./util";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100 * 1024;
// Output is capped at 100KB anyway, so reading past 1MB can never be shown.
const MAX_READ_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

function decodeUtf16be(buf: Buffer): string {
  const len = buf.length - (buf.length % 2);
  const swapped = Buffer.allocUnsafe(len);
  for (let k = 0; k < len; k += 2) {
    swapped[k] = buf[k + 1] ?? 0;
    swapped[k + 1] = buf[k] ?? 0;
  }
  return swapped.toString("utf16le");
}

// A UTF-16 BOM means the file is text (its NUL bytes are expected); without a
// BOM, a NUL in the first 8KB marks a binary file.
function decodeTextBuffer(buf: Buffer): { text: string } | { binary: true } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le") };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: decodeUtf16be(buf.subarray(2)) };
  }
  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { binary: true };
  }
  return { text: buf.toString("utf8") };
}

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory"),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("1-based line number to start reading from"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of lines to read (default 2000)"),
});

// Per-tool-instance cache of what was already sent to the model, so a re-read
// of an unchanged file (same mtime + size) whose requested line range was
// already returned answers with a one-line note instead of re-billing the
// full content (aider's read-file dedup). Keyed by realpath when resolvable.
interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
  totalLines: number;
  start: number;
  end: number;
}
const READ_CACHE_MAX_ENTRIES = 200;

export function createReadFileTool(): Tool<typeof schema> {
  const cache = new Map<string, ReadCacheEntry>();
  return {
    name: "read_file",
    description:
      "Read a text file and return its contents with line numbers. Output is truncated to 2000 lines or 100KB by default. Re-reading an unchanged file range returns a short note instead of the content.",
    permission: "read",
    parameters: schema,
    reset: () => cache.clear(),
    async execute(args, ctx) {
      const filePath = path.resolve(ctx.cwd, args.path);
      // Check both the given path and its symlink target: a repo can plant a
      // harmless-looking link (notes.txt -> ~/.ssh/id_rsa) whose resolved name
      // is on the sensitive list. Unresolvable paths keep the raw-path check.
      const resolvedPath = await realpath(filePath).catch(() => null);
      if (isSensitivePath(filePath) || (resolvedPath !== null && isSensitivePath(resolvedPath))) {
        return { content: `Refused to read sensitive file: ${args.path}`, isError: true };
      }
      const st = await stat(filePath).catch(() => null);
      if (!st) {
        return { content: `File not found: ${args.path}`, isError: true };
      }
      if (st.isDirectory()) {
        return { content: `Path is a directory, not a file: ${args.path}`, isError: true };
      }
      const start = args.offset ?? 1;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const cacheKey = resolvedPath ?? filePath;
      const hit = cache.get(cacheKey);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        const requestedEnd = Math.min(hit.totalLines, start - 1 + limit);
        if (start >= hit.start && requestedEnd <= hit.end && start <= hit.totalLines) {
          return {
            content: `[unchanged since last read: ${args.path} — lines ${start}-${requestedEnd} of ${hit.totalLines} are already in context and the file has not changed]`,
          };
        }
      }
      const bytesToRead = Math.min(st.size, MAX_READ_BYTES);
      const fileCapped = st.size > MAX_READ_BYTES;
      const handle = await open(filePath, "r").catch(() => null);
      if (!handle) {
        return { content: `Failed to read ${args.path}`, isError: true };
      }
      let buf: Buffer;
      try {
        const { bytesRead, buffer } = await handle.read(
          Buffer.alloc(bytesToRead),
          0,
          bytesToRead,
          0,
        );
        buf = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close().catch(() => {});
      }
      const decoded = decodeTextBuffer(buf);
      if ("binary" in decoded) {
        return { content: `Cannot read binary file: ${args.path}`, isError: true };
      }
      const lines = decoded.text.split("\n");
      const totalDesc = fileCapped ? `at least ${lines.length}` : `${lines.length}`;
      if (start > lines.length) {
        return { content: `(offset ${start} beyond end of file; file has ${totalDesc} lines)` };
      }
      const end = Math.min(lines.length, start - 1 + limit);
      const out: string[] = [];
      let size = 0;
      let truncatedBySize = false;
      for (let i = start - 1; i < end; i++) {
        const line = (lines[i] ?? "").replace(/\r$/, "");
        const numbered = `${i + 1}\t${line}`;
        if (size + numbered.length > MAX_CHARS) {
          truncatedBySize = true;
          break;
        }
        out.push(numbered);
        size += numbered.length;
      }
      const lastShown = start - 1 + out.length;
      if (truncatedBySize) {
        out.push(
          `... (truncated: output exceeds 100KB, showing lines ${start}-${lastShown} of ${totalDesc})`,
        );
      } else if (end < lines.length || fileCapped) {
        out.push(`... (truncated: showing lines ${start}-${end} of ${totalDesc})`);
      }
      if (out.length > 0) {
        if (cache.size >= READ_CACHE_MAX_ENTRIES) cache.clear();
        const prev = hit?.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : undefined;
        cache.set(cacheKey, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          totalLines: lines.length,
          // Extend the remembered range when the new read overlaps or abuts
          // the previous one; disjoint ranges replace it.
          start: prev && start <= prev.end + 1 ? Math.min(prev.start, start) : start,
          end: prev && lastShown >= prev.start - 1 ? Math.max(prev.end, lastShown) : lastShown,
        });
      }
      return { content: out.join("\n") };
    },
  };
}

// Shared instance for direct consumers (tests); the tool registry creates a
// fresh one per agent loop so a subagent's cache never claims content that
// only the parent's context holds.
export const readFileTool = createReadFileTool();
