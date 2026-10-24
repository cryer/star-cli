import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { MAX_SNAPSHOT_CONTENT_BYTES, captureSnapshot, pushSnapshot } from "./snapshots";
import { isSensitivePath, realpathForCheck } from "./util";

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
    // Same symlink defense as read_file: a repo can plant a harmless-looking
    // link (config.json -> .env) whose resolved name is on the sensitive
    // list, and the permission gate only name-checks the raw path — so this
    // runs in-tool, unreachable by yolo mode or hooks. Unresolvable (new)
    // paths resolve the parent and re-attach the basename.
    const resolvedPath = await realpathForCheck(filePath);
    if (isSensitivePath(filePath) || (resolvedPath !== null && isSensitivePath(resolvedPath))) {
      return { content: `Refused to write sensitive file: ${args.path}`, isError: true };
    }
    // write_file writes UTF-8 text: NUL bytes mean the model is pushing
    // binary content that would land corrupted. The size limit matches
    // edit_file and keeps snapshots bounded.
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
    if (snapshot.existed && snapshot.content === null) {
      const reason = snapshot.contentTooLarge
        ? "existing content is over the 5MB snapshot limit"
        : "existing content could not be read";
      return {
        content: `Refused to overwrite ${args.path}: ${reason}, and no restorable snapshot is available`,
        isError: true,
      };
    }
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
