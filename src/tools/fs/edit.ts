import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import {
  MAX_SNAPSHOT_CONTENT_BYTES,
  currentTurnMessageIndex,
  currentTurnSeq,
  nextSnapshotId,
  pushSnapshot,
} from "./snapshots";

// Same heuristic as read_file: a NUL in the first 8KB marks a binary file.
// edit_file writes back as UTF-8, so an ASCII old_string that happens to
// match inside a binary file would corrupt it irreversibly (U+FFFD
// replacement on undecodable bytes), and snapshots cannot restore it.
const BINARY_PROBE_BYTES = 8192;

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory"),
  old_string: z.string().min(1).describe("Exact text to replace"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z
    .boolean()
    .optional()
    .describe("Replace every occurrence instead of requiring a unique match"),
});

export const editFileTool: Tool<typeof schema> = {
  name: "edit_file",
  description:
    "Replace an exact string in a file. Fails if old_string is not found or matches multiple locations unless replace_all is set. Refuses binary files and files over 5MB.",
  permission: "write",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    let content: string;
    let readMtimeMs: number;
    try {
      const st = await stat(filePath);
      // Past the snapshot content cap /undo keeps only metadata, so an edit
      // would be unrecoverable — refuse instead of writing blind.
      if (st.size > MAX_SNAPSHOT_CONTENT_BYTES) {
        return {
          content: `Refused to edit ${args.path}: file is ${st.size} bytes, over the 5MB limit (edits past it could not be restored by /undo)`,
          isError: true,
        };
      }
      readMtimeMs = st.mtimeMs;
      const buf = await readFile(filePath);
      if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        return { content: `Refused to edit binary file: ${args.path}`, isError: true };
      }
      content = buf.toString("utf8");
    } catch (err) {
      return { content: `Failed to read ${args.path}: ${(err as Error).message}`, isError: true };
    }
    // Dual-path matching: exact first. When that finds nothing, retry in an
    // LF-normalized space — read_file strips \r for display, so on a CRLF
    // file the model can only phrase a multi-line old_string with \n, which
    // never matches the raw bytes. Uniqueness/replace_all counts are judged
    // in the normalized space; after replacing there, the text is converted
    // back to the original file's dominant line ending before writing.
    let working = content;
    let oldString = args.old_string;
    let newString = args.new_string;
    let restoreEol: ((text: string) => string) | null = null;
    let count = countOccurrences(working, oldString);
    if (count === 0) {
      const normalizedContent = normalizeEol(content);
      const normalizedOld = normalizeEol(oldString);
      const normalizedCount = countOccurrences(normalizedContent, normalizedOld);
      if (normalizedCount > 0) {
        const crlfCount = countOccurrences(content, "\r\n");
        const loneLfCount = countOccurrences(content.replace(/\r\n/g, ""), "\n");
        restoreEol =
          crlfCount > 0 && crlfCount >= loneLfCount ? (text) => text.replace(/\n/g, "\r\n") : null;
        working = normalizedContent;
        oldString = normalizedOld;
        newString = normalizeEol(newString);
        count = normalizedCount;
      }
    }
    if (count === 0) {
      return { content: `old_string not found in ${args.path}`, isError: true };
    }
    if (count > 1 && !args.replace_all) {
      return {
        content: `old_string matches ${count} locations in ${args.path}; provide more surrounding context or set replace_all`,
        isError: true,
      };
    }
    let updated = args.replace_all
      ? working.split(oldString).join(newString)
      : working.replace(oldString, () => newString);
    if (restoreEol) {
      updated = restoreEol(updated);
    }
    try {
      // Guard against a silent overwrite when the file changed on disk
      // between our read and our write.
      const now = await stat(filePath).catch(() => null);
      if (!now || now.mtimeMs !== readMtimeMs) {
        return {
          content: `Failed to edit ${args.path}: file changed since it was read; re-read and retry`,
          isError: true,
        };
      }
      await writeFile(filePath, updated, "utf8");
    } catch (err) {
      return { content: `Failed to write ${args.path}: ${(err as Error).message}`, isError: true };
    }
    const contentTooLarge = Buffer.byteLength(content, "utf8") > MAX_SNAPSHOT_CONTENT_BYTES;
    await pushSnapshot({
      id: nextSnapshotId(),
      path: filePath,
      existed: true,
      content: contentTooLarge ? null : content,
      contentTooLarge: contentTooLarge || undefined,
      toolName: "edit_file",
      timestamp: Date.now(),
      turn: ctx.snapshotContext?.turn ?? currentTurnSeq(),
      messageIndex: ctx.snapshotContext?.messageIndex ?? currentTurnMessageIndex(),
      owner: ctx.snapshotContext?.owner ?? "root",
    });
    return { content: `Edited ${args.path}: ${count} replacement${count > 1 ? "s" : ""}` };
  },
};
