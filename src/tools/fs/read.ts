import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { Tool } from "../types";
import { isSensitivePath } from "./util";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100 * 1024;
const BINARY_PROBE_BYTES = 8192;
const READ_CHUNK_BYTES = 64 * 1024;

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

interface ReadWindow {
  totalLines: number;
  out: string[];
  lastShown: number;
  truncatedBySize: boolean;
}

async function readWindow(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
  start: number,
  limit: number,
): Promise<ReadWindow | { binary: true }> {
  const probe = Buffer.alloc(Math.min(size, BINARY_PROBE_BYTES));
  const { bytesRead: probeBytes } = await handle.read(probe, 0, probe.length, 0);
  const head = probe.subarray(0, probeBytes);
  const utf16le = head[0] === 0xff && head[1] === 0xfe;
  const utf16be = head[0] === 0xfe && head[1] === 0xff;
  if (!utf16le && !utf16be && head.includes(0)) return { binary: true };

  const decoder = new StringDecoder(utf16le || utf16be ? "utf16le" : "utf8");
  const requestedEnd = start - 1 + limit;
  const result: ReadWindow = {
    totalLines: 1,
    out: [],
    lastShown: start - 1,
    truncatedBySize: false,
  };
  let lineNumber = 1;
  let outputSize = 0;
  let pending = "";
  let beRemainder: number | undefined;
  const showLine = (raw: string) => {
    if (lineNumber >= start && lineNumber <= requestedEnd && !result.truncatedBySize) {
      const numbered = `${lineNumber}\t${raw.replace(/\r$/, "")}`;
      if (outputSize + numbered.length > MAX_CHARS) {
        result.truncatedBySize = true;
      } else {
        result.out.push(numbered);
        outputSize += numbered.length;
        result.lastShown = lineNumber;
      }
    }
  };
  const accept = (text: string) => {
    const parts = `${pending}${text}`.split("\n");
    for (let i = 0; i < parts.length - 1; i += 1) {
      showLine(parts[i] ?? "");
      lineNumber += 1;
    }
    pending = parts[parts.length - 1] ?? "";
  };

  let position = utf16le || utf16be ? 2 : 0;
  while (position < size) {
    const length = Math.min(READ_CHUNK_BYTES, size - position);
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    let chunk = buffer.subarray(0, bytesRead);
    if (utf16be) {
      const combined =
        beRemainder === undefined ? chunk : Buffer.concat([Buffer.from([beRemainder]), chunk]);
      const pairedLength = combined.length - (combined.length % 2);
      const swapped = Buffer.allocUnsafe(pairedLength);
      for (let i = 0; i < pairedLength; i += 2) {
        swapped[i] = combined[i + 1] ?? 0;
        swapped[i + 1] = combined[i] ?? 0;
      }
      beRemainder = pairedLength < combined.length ? combined[combined.length - 1] : undefined;
      chunk = swapped;
    }
    accept(decoder.write(chunk));
  }
  accept(decoder.end());
  showLine(pending);
  result.totalLines = lineNumber;
  return result;
}

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
      const handle = await open(filePath, "r").catch(() => null);
      if (!handle) {
        return { content: `Failed to read ${args.path}`, isError: true };
      }
      let decoded: ReadWindow | { binary: true };
      try {
        decoded = await readWindow(handle, st.size, start, limit);
      } catch {
        return { content: `Failed to read ${args.path}`, isError: true };
      } finally {
        await handle.close().catch(() => {});
      }
      if ("binary" in decoded) {
        return { content: `Cannot read binary file: ${args.path}`, isError: true };
      }
      const { totalLines, out, lastShown, truncatedBySize } = decoded;
      if (start > totalLines) {
        return { content: `(offset ${start} beyond end of file; file has ${totalLines} lines)` };
      }
      const end = Math.min(totalLines, start - 1 + limit);
      if (truncatedBySize) {
        out.push(
          `... (truncated: output exceeds 100KB, showing lines ${start}-${lastShown} of ${totalLines})`,
        );
      } else if (end < totalLines) {
        out.push(`... (truncated: showing lines ${start}-${end} of ${totalLines})`);
      }
      if (out.length > 0) {
        if (cache.size >= READ_CACHE_MAX_ENTRIES) cache.clear();
        const prev = hit?.mtimeMs === st.mtimeMs && hit.size === st.size ? hit : undefined;
        cache.set(cacheKey, {
          mtimeMs: st.mtimeMs,
          size: st.size,
          totalLines,
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
