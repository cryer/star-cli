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
    "Replace an exact string in a file. Fails if old_string is not found or matches multiple locations unless replace_all is set.",
  permission: "write",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    let content: string;
    let readMtimeMs: number;
    try {
      content = await readFile(filePath, "utf8");
      readMtimeMs = (await stat(filePath)).mtimeMs;
    } catch (err) {
      return { content: `Failed to read ${args.path}: ${(err as Error).message}`, isError: true };
    }
    let count = 0;
    let idx = content.indexOf(args.old_string);
    while (idx !== -1) {
      count += 1;
      idx = content.indexOf(args.old_string, idx + args.old_string.length);
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
    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, () => args.new_string);
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
