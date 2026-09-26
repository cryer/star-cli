import { open, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import { isSensitivePath } from "./util";

const DEFAULT_LIMIT = 2000;
const MAX_CHARS = 100 * 1024;
// Output is capped at 100KB anyway, so reading past 1MB can never be shown.
const MAX_READ_BYTES = 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;

function decodeUtf16be(buf: Buffer): string {
  const len = buf.length - (buf.length % 2);
  const swapped = Buffer.allocUnsafe(len);
  for (let k = 0; k < len; k += 2) {
    swapped[k] = buf[k + 1] ?? 0;
    swapped[k + 1] = buf[k] ?? 0;
  }
  return swapped.toString("utf16le");
}

// A UTF-16 BOM means the file is text (its NUL bytes are expected); without a
// BOM, a NUL in the first 8KB marks a binary file.
function decodeTextBuffer(buf: Buffer): { text: string } | { binary: true } {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString("utf16le") };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: decodeUtf16be(buf.subarray(2)) };
  }
  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return { binary: true };
  }
  return { text: buf.toString("utf8") };
}

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
    const bytesToRead = Math.min(st.size, MAX_READ_BYTES);
    const fileCapped = st.size > MAX_READ_BYTES;
    const handle = await open(filePath, "r").catch(() => null);
    if (!handle) {
      return { content: `Failed to read ${args.path}`, isError: true };
    }
    let buf: Buffer;
    try {
      const { bytesRead, buffer } = await handle.read(Buffer.alloc(bytesToRead), 0, bytesToRead, 0);
      buf = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close().catch(() => {});
    }
    const decoded = decodeTextBuffer(buf);
    if ("binary" in decoded) {
      return { content: `Cannot read binary file: ${args.path}`, isError: true };
    }
    const lines = decoded.text.split("\n");
    const totalDesc = fileCapped ? `at least ${lines.length}` : `${lines.length}`;
    const start = args.offset ?? 1;
    const limit = args.limit ?? DEFAULT_LIMIT;
    if (start > lines.length) {
      return { content: `(offset ${start} beyond end of file; file has ${totalDesc} lines)` };
    }
    const end = Math.min(lines.length, start - 1 + limit);
    const out: string[] = [];
    let size = 0;
    let truncatedBySize = false;
    for (let i = start - 1; i < end; i++) {
      const line = (lines[i] ?? "").replace(/\r$/, "");
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
        `... (truncated: output exceeds 100KB, showing lines ${start}-${lastShown} of ${totalDesc})`,
      );
    } else if (end < lines.length || fileCapped) {
      out.push(`... (truncated: showing lines ${start}-${end} of ${totalDesc})`);
    }
    return { content: out.join("\n") };
  },
};
