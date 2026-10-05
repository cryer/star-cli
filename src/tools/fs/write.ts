import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { MAX_SNAPSHOT_CONTENT_BYTES, captureSnapshot, pushSnapshot } from "./snapshots";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory"),
  content: z.string().describe("Full content to write to the file"),
});

export const writeFileTool: Tool<typeof schema> = {
  name: "write_file",
  description:
    "Write content to a file, creating parent directories as needed. Overwrites existing files. Refuses content with NUL bytes (binary) or over 5MB.",
  permission: "write",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    // write_file writes UTF-8 text: NUL bytes mean the model is pushing
    // binary content that would land corrupted, and past the snapshot cap
    // /undo keeps only metadata, so the overwritten file would be
    // unrecoverable — same limits as edit_file.
    if (args.content.includes("\0")) {
      return {
        content: `Refused to write ${args.path}: content contains NUL bytes (write_file is text-only)`,
        isError: true,
      };
    }
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > MAX_SNAPSHOT_CONTENT_BYTES) {
      return {
        content: `Refused to write ${args.path}: content is ${bytes} bytes, over the 5MB limit (writes past it could not be restored by /undo)`,
        isError: true,
      };
    }
    const snapshot = await captureSnapshot(filePath, "write_file", ctx.snapshotContext);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, "utf8");
    } catch (err) {
      return { content: `Failed to write ${args.path}: ${(err as Error).message}`, isError: true };
    }
    await pushSnapshot(snapshot);
    return { content: `Wrote ${bytes} bytes to ${args.path}` };
  },
};
