import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";

const schema = z.object({
  path: z.string().describe("File path, absolute or relative to the working directory"),
  content: z.string().describe("Full content to write to the file"),
});

export const writeFileTool: Tool<typeof schema> = {
  name: "write_file",
  description:
    "Write content to a file, creating parent directories as needed. Overwrites existing files.",
  permission: "write",
  parameters: schema,
  async execute(args, ctx) {
    const filePath = path.resolve(ctx.cwd, args.path);
    try {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, args.content, "utf8");
    } catch (err) {
      return { content: `Failed to write ${args.path}: ${(err as Error).message}`, isError: true };
    }
    return { content: `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}` };
  },
};
