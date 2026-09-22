import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { type WalkedFile, createIgnorePredicate, matchesGlob, walkFiles } from "./util";

const MAX_MATCHES = 250;

const schema = z.object({
  pattern: z.string().describe("Regular expression to search for"),
  path: z
    .string()
    .optional()
    .describe("File or directory to search, defaults to the working directory"),
  glob: z
    .string()
    .optional()
    .describe("Glob pattern to filter which files are searched, e.g. '*.ts'"),
  ignoreCase: z.boolean().optional().describe("Case-insensitive matching"),
});

export const grepTool: Tool<typeof schema> = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Outputs 'file:line:content', up to 250 matches. Skips binary files, node_modules and .git.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
    } catch (err) {
      return { content: `Invalid regular expression: ${(err as Error).message}`, isError: true };
    }
    const root = path.resolve(ctx.cwd, args.path ?? ".");
    let files: WalkedFile[];
    try {
      const st = await stat(root);
      if (st.isFile()) {
        files = [{ abs: root, rel: path.basename(root), mtimeMs: st.mtimeMs }];
      } else {
        files = await walkFiles(root, undefined, { ignore: createIgnorePredicate(ctx.cwd) });
      }
    } catch {
      return { content: `Path not found: ${args.path ?? "."}`, isError: true };
    }
    if (args.glob) {
      const glob = args.glob;
      files = files.filter((f) => matchesGlob(glob, f.rel));
    }
    const out: string[] = [];
    let truncated = false;
    outer: for (const file of files) {
      let buf: Buffer;
      try {
        buf = await readFile(file.abs);
      } catch {
        continue;
      }
      if (buf.includes(0)) {
        continue;
      }
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          out.push(`${file.rel}:${i + 1}:${line}`);
          if (out.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    if (out.length === 0) {
      return { content: `No matches for pattern: ${args.pattern}` };
    }
    if (truncated) {
      out.push(`... (truncated: more than ${MAX_MATCHES} matches)`);
    }
    return { content: out.join("\n") };
  },
};
