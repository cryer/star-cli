import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { createIgnorePredicate, matchesGlob, walkFiles } from "./util";

const MAX_RESULTS = 100;

const GLOB_MAGIC = /[*?[{]/;

// Leading directory segments without glob magic (everything before the final
// segment, which may name a file) let src/**/*.ts walk <root>/src directly
// instead of descending the whole tree. Matched paths are re-prefixed before
// matching and display so output stays relative to the requested root.
function literalDirPrefix(pattern: string): string[] {
  const segments = pattern.replace(/\\/g, "/").split("/").slice(0, -1);
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || GLOB_MAGIC.test(segment)) {
      break;
    }
    out.push(segment);
  }
  return out;
}

const schema = z.object({
  pattern: z
    .string()
    .describe(
      "Glob pattern, e.g. 'src/**/*.ts'. Supports **, *, ?, {a,b} braces and [abc] character classes. A bare pattern like '*.ts' matches basenames recursively.",
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
    const prefixSegments = literalDirPrefix(args.pattern);
    const walkRoot = prefixSegments.length > 0 ? path.join(root, ...prefixSegments) : root;
    const prefix = prefixSegments.length > 0 ? `${prefixSegments.join("/")}/` : "";
    const files = await walkFiles(walkRoot, undefined, { ignore: createIgnorePredicate(ctx.cwd) });
    const matched = files
      .filter((f) => matchesGlob(args.pattern, `${prefix}${f.rel}`))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_RESULTS);
    if (matched.length === 0) {
      return { content: `No files matched pattern: ${args.pattern}` };
    }
    return { content: matched.map((f) => `${prefix}${f.rel}`).join("\n") };
  },
};
