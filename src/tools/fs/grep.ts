import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import {
  type WalkedFile,
  createIgnorePredicate,
  isSensitivePath,
  matchesGlob,
  walkFiles,
} from "./util";

const MAX_MATCHES = 250;
const MAX_LINE_CHARS = 500;
const MAX_PATTERN_CHARS = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

// Very long patterns are usually pasted blobs, and a quantified group is the
// classic catastrophic-backtracking shape — reject both before they hang the
// process on a large tree.
function isTooComplexPattern(pattern: string): boolean {
  return (
    pattern.length > MAX_PATTERN_CHARS || /\)[+*]/.test(pattern) || /\)\{\d+(,\d*)?\}/.test(pattern)
  );
}

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
    "Search file contents with a regular expression. Outputs 'file:line:content', up to 250 matches. Skips binary files, files over 5MB, sensitive files, node_modules and .git.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    if (isTooComplexPattern(args.pattern)) {
      return {
        content: `pattern too complex: keep it under ${MAX_PATTERN_CHARS} characters and avoid quantified groups like (a+)+`,
        isError: true,
      };
    }
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
        if (isSensitivePath(root)) {
          return {
            content: `Refused to grep sensitive file: ${args.path ?? "."}`,
            isError: true,
          };
        }
        files = [{ abs: root, rel: path.basename(root), mtimeMs: st.mtimeMs }];
      } else {
        const walked = await walkFiles(root, undefined, {
          ignore: createIgnorePredicate(ctx.cwd),
          withMtime: false,
        });
        files = walked.filter((f) => !isSensitivePath(f.abs));
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
    let skippedLarge = 0;
    outer: for (const file of files) {
      const st = await stat(file.abs).catch(() => null);
      if (!st) {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
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
          const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          out.push(`${file.rel}:${i + 1}:${shown}`);
          if (out.length >= MAX_MATCHES) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    const skippedNote =
      skippedLarge > 0 ? `(skipped ${skippedLarge} file(s) larger than 5MB)` : null;
    if (out.length === 0) {
      return {
        content: `No matches for pattern: ${args.pattern}${skippedNote ? ` ${skippedNote}` : ""}`,
      };
    }
    if (truncated) {
      out.push(`... (truncated: more than ${MAX_MATCHES} matches)`);
    }
    if (skippedNote) {
      out.push(`... ${skippedNote}`);
    }
    return { content: out.join("\n") };
  },
};
