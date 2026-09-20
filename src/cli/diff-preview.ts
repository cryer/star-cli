import { readFile } from "node:fs/promises";
import path from "node:path";

export type DiffLineKind = "add" | "del" | "context" | "marker";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface DiffPreview {
  type: "diff" | "new-file";
  label: string;
  lines: DiffLine[];
}

const CONTEXT_LINES = 2;
const MAX_HUNK_LINES = 15;
const MAX_TOTAL_LINES = 12;
const NEW_FILE_PREVIEW_LINES = 10;
const MAX_DP_CELLS = 250_000;

interface Op {
  kind: Exclude<DiffLineKind, "marker">;
  text: string;
}

function diffOps(oldText: string, newText: string): Op[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const prefix: Op[] = a.slice(0, start).map((text) => ({ kind: "context" as const, text }));
  const suffix: Op[] = a.slice(endA).map((text) => ({ kind: "context" as const, text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const prefixLen = prefix.length;
  const ops: Op[] = [...prefix];
  if (midA.length * midB.length > MAX_DP_CELLS) {
    for (const text of midA) ops.push({ kind: "del", text });
    for (const text of midB) ops.push({ kind: "add", text });
  } else if (midA.length > 0 || midB.length > 0) {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const dp = new Uint32Array(rows * cols);
    const cell = (r: number, c: number): number => dp[r * cols + c] ?? 0;
    for (let i = 1; i < rows; i++) {
      for (let j = 1; j < cols; j++) {
        dp[i * cols + j] =
          midA[i - 1] === midB[j - 1]
            ? cell(i - 1, j - 1) + 1
            : Math.max(cell(i - 1, j), cell(i, j - 1));
      }
    }
    const lineAt = (lines: string[], index: number): string => lines[index] ?? "";
    const middle: Op[] = [];
    let i = midA.length;
    let j = midB.length;
    while (i > 0 && j > 0) {
      if (midA[i - 1] === midB[j - 1]) {
        middle.push({ kind: "context", text: lineAt(midA, i - 1) });
        i -= 1;
        j -= 1;
      } else if (cell(i, j - 1) >= cell(i - 1, j)) {
        middle.push({ kind: "add", text: lineAt(midB, j - 1) });
        j -= 1;
      } else {
        middle.push({ kind: "del", text: lineAt(midA, i - 1) });
        i -= 1;
      }
    }
    while (i > 0) {
      middle.push({ kind: "del", text: lineAt(midA, i - 1) });
      i -= 1;
    }
    while (j > 0) {
      middle.push({ kind: "add", text: lineAt(midB, j - 1) });
      j -= 1;
    }
    middle.reverse();
    ops.push(...middle);
  }
  ops.push(...suffix);
  return ops.length === prefixLen + suffix.length ? [] : ops;
}

function hunkRanges(ops: Op[]): Array<[number, number]> {
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op && op.kind !== "context") changes.push(i);
  }
  const ranges: Array<[number, number]> = [];
  let groupStart = 0;
  for (let k = 1; k <= changes.length; k++) {
    const cur = changes[k];
    const prev = changes[k - 1];
    const first = changes[groupStart];
    if (prev === undefined || first === undefined) break;
    if (cur === undefined || cur - prev > CONTEXT_LINES * 2 + 1) {
      ranges.push([
        Math.max(0, first - CONTEXT_LINES),
        Math.min(ops.length, prev + CONTEXT_LINES + 1),
      ]);
      groupStart = k;
    }
  }
  return ranges;
}

export function buildDiffLines(oldText: string, newText: string): DiffLine[] {
  const ops = diffOps(oldText, newText);
  if (ops.length === 0) return [];
  const ranges = hunkRanges(ops);
  const lines: DiffLine[] = [];
  let omitted = 0;
  for (const [rangeIndex, [start, end]] of ranges.entries()) {
    if (rangeIndex > 0) lines.push({ kind: "marker", text: "···" });
    const hunk = ops.slice(start, end);
    let shown = hunk;
    if (hunk.length > MAX_HUNK_LINES) {
      const headCount = Math.ceil(MAX_HUNK_LINES / 2);
      shown = [...hunk.slice(0, headCount), ...hunk.slice(headCount - MAX_HUNK_LINES)];
    }
    if (hunk.length > shown.length) {
      omitted += hunk.length - shown.length;
    }
    for (const op of shown) lines.push(op);
  }
  if (lines.length > MAX_TOTAL_LINES) {
    omitted += lines.length - MAX_TOTAL_LINES;
    lines.length = MAX_TOTAL_LINES;
  }
  if (omitted > 0) lines.push({ kind: "marker", text: `... (${omitted} more lines)` });
  return lines;
}

function getStringArg(args: unknown, key: string): string | undefined {
  if (typeof args === "object" && args !== null) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): string | null {
  let count = 0;
  let idx = content.indexOf(oldString);
  while (idx !== -1) {
    count += 1;
    idx = content.indexOf(oldString, idx + oldString.length);
  }
  if (count === 0) return null;
  if (count > 1 && !replaceAll) return null;
  return replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);
}

function newFilePreview(content: string, label: string): DiffPreview {
  const all = content.split("\n");
  const shown = all.slice(0, NEW_FILE_PREVIEW_LINES);
  const lines: DiffLine[] = shown.map((text) => ({ kind: "add", text }));
  if (all.length > shown.length) {
    lines.push({ kind: "marker", text: `... (${all.length - shown.length} more lines)` });
  }
  return { type: "new-file", label, lines };
}

export async function generateDiffPreview(
  toolName: string,
  args: unknown,
  cwd: string,
): Promise<DiffPreview | null> {
  if (toolName !== "edit_file" && toolName !== "write_file") return null;
  const filePath = getStringArg(args, "path");
  if (filePath === undefined) return null;
  const absolute = path.resolve(cwd, filePath);
  let existing: string | null;
  try {
    existing = await readFile(absolute, "utf8");
  } catch {
    existing = null;
  }
  if (toolName === "edit_file") {
    const oldString = getStringArg(args, "old_string");
    const newString = getStringArg(args, "new_string");
    if (existing === null || oldString === undefined || newString === undefined) return null;
    const replaceAll =
      typeof args === "object" &&
      args !== null &&
      (args as Record<string, unknown>).replace_all === true;
    const updated = applyEdit(existing, oldString, newString, replaceAll);
    if (updated === null) return null;
    return { type: "diff", label: filePath, lines: buildDiffLines(existing, updated) };
  }
  const content = getStringArg(args, "content");
  if (content === undefined) return null;
  if (existing === null) return newFilePreview(content, filePath);
  return { type: "diff", label: filePath, lines: buildDiffLines(existing, content) };
}
