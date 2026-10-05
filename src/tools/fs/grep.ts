import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import {
  WALK_CONCURRENCY,
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
    "Search file contents with a regular expression. Outputs 'file:line:content', up to 250 matches. Skips binary files, files over 5MB, sensitive files, node_modules and .git. Follows symlinks that stay inside the working directory.",
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
    let interrupted = false;
    try {
      const st = await stat(root);
      if (st.isFile()) {
        // Symlink targets are checked too: a link named notes.txt can point
        // at a sensitive file whose resolved basename is on the blocklist.
        const resolved = await realpath(root).catch(() => null);
        if (isSensitivePath(root) || (resolved !== null && isSensitivePath(resolved))) {
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
          signal: ctx.abortSignal,
          symlinkBoundary: ctx.cwd,
          nestedIgnore: true,
        });
        interrupted = walked.aborted;
        // A link named notes.txt can resolve to a sensitive target inside the
        // cwd; check the resolved path as well as the link path.
        files = walked.files.filter(
          (f) =>
            !isSensitivePath(f.abs) && (f.resolved === undefined || !isSensitivePath(f.resolved)),
        );
      }
    } catch {
      return { content: `Path not found: ${args.path ?? "."}`, isError: true };
    }
    if (args.glob) {
      const glob = args.glob;
      files = files.filter((f) => matchesGlob(glob, f.rel));
    }
    // Files are scanned in concurrent chunks; matches are appended in file
    // order so output stays deterministic and the 250-match cut is stable.
    const scanFile = async (file: WalkedFile): Promise<string[] | null> => {
      const st = await stat(file.abs).catch(() => null);
      if (!st) {
        return null;
      }
      if (st.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        return null;
      }
      let buf: Buffer;
      try {
        buf = await readFile(file.abs);
      } catch {
        return null;
      }
      if (buf.includes(0)) {
        return null;
      }
      const hits: string[] = [];
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) {
          const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          hits.push(`${file.rel}:${i + 1}:${shown}`);
        }
      }
      return hits;
    };
    const out: string[] = [];
    let truncated = false;
    let skippedLarge = 0;
    outer: for (let i = 0; i < files.length; i += WALK_CONCURRENCY) {
      if (ctx.abortSignal?.aborted) {
        interrupted = true;
        break;
      }
      const chunk = await Promise.all(
        files.slice(i, i + WALK_CONCURRENCY).map((file) => scanFile(file)),
      );
      for (const hits of chunk) {
        if (!hits) {
          continue;
        }
        for (const hit of hits) {
          out.push(hit);
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
        content: `No matches for pattern: ${args.pattern}${skippedNote ? ` ${skippedNote}` : ""}${interrupted ? " (search interrupted)" : ""}`,
      };
    }
    if (truncated) {
      out.push(`... (truncated: more than ${MAX_MATCHES} matches)`);
    } else if (interrupted) {
      out.push("... (interrupted: partial results)");
    }
    if (skippedNote) {
      out.push(`... ${skippedNote}`);
    }
    return { content: out.join("\n") };
  },
};
