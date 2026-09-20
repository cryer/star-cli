import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { currentTurnSeq, pushSnapshot } from "./snapshots";

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
    try {
      content = await readFile(filePath, "utf8");
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
      : content.replace(args.old_string, args.new_string);
    try {
      await writeFile(filePath, updated, "utf8");
    } catch (err) {
      return { content: `Failed to write ${args.path}: ${(err as Error).message}`, isError: true };
    }
    pushSnapshot({
      path: filePath,
      existed: true,
      content,
      toolName: "edit_file",
      timestamp: Date.now(),
      turn: currentTurnSeq(),
    });
    return { content: `Edited ${args.path}: ${count} replacement${count > 1 ? "s" : ""}` };
  },
};
