import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { createIgnorePredicate, matchesGlob, walkFiles } from "./util";

const MAX_RESULTS = 100;

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern, e.g. 'src/**/*.ts'. Supports **, * and ?. A bare pattern like '*.ts' matches basenames recursively.",
    ),
  path: z.string().optional().describe("Directory to search, defaults to the working directory"),
});

export const globTool: Tool<typeof schema> = {
  name: "glob",
  description:
    "Find files by glob pattern. Skips node_modules, .git and dist. Returns paths sorted by modification time, newest first, up to 100 results.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const root = path.resolve(ctx.cwd, args.path ?? ".");
    const files = await walkFiles(root, undefined, { ignore: createIgnorePredicate(ctx.cwd) });
    const matched = files
      .filter((f) => matchesGlob(args.pattern, f.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RESULTS);
    if (matched.length === 0) {
      return { content: `No files matched pattern: ${args.pattern}` };
    }
    return { content: matched.map((f) => f.rel).join("\n") };
  },
};
