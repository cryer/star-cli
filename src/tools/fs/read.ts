import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { isSensitivePath } from "./util";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100 * 1024;

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

export const readFileTool: Tool<typeof schema> = {
  name: "read_file",
  description:
    "Read a text file and return its contents with line numbers. Output is truncated to 2000 lines or 100KB by default.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    if (isSensitivePath(filePath)) {
      return { content: `Refused to read sensitive file: ${args.path}`, isError: true };
    }
    const st = await stat(filePath).catch(() => null);
    if (!st) {
      return { content: `File not found: ${args.path}`, isError: true };
    }
    if (st.isDirectory()) {
      return { content: `Path is a directory, not a file: ${args.path}`, isError: true };
    }
    const raw = await readFile(filePath, "utf8");
    const lines = raw.split("\n");
    const start = args.offset ?? 1;
    const limit = args.limit ?? DEFAULT_LIMIT;
    const end = Math.min(lines.length, start - 1 + limit);
    const out: string[] = [];
    let size = 0;
    let truncatedBySize = false;
    for (let i = start - 1; i < end; i++) {
      const line = lines[i];
      if (line === undefined) {
        break;
      }
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
        `... (truncated: output exceeds 100KB, showing lines ${start}-${lastShown} of ${lines.length})`,
      );
    } else if (end < lines.length) {
      out.push(`... (truncated: showing lines ${start}-${end} of ${lines.length})`);
    }
    return { content: out.join("\n") };
  },
};
