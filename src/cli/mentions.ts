import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageInput } from "../core/messages";
import {
  type IgnorePredicate,
  SKIP_DIRS,
  createIgnorePredicate,
  isSensitivePath,
} from "../tools/fs/util";
import { downsampleImageIfNeeded } from "./image";

export const MAX_MENTION_BYTES = 100 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DIR_MENTION_ENTRIES = 200;
export const MAX_DIR_MENTION_DEPTH = 10;
// Backstop for the total-entry count: past this the listing reports "many
// more entries" instead of counting a huge tree (e.g. @. in a repo) to the
// end.
export const MAX_DIR_MENTION_TOTAL = 5000;

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function imageMimeType(filePath: string): string | null {
  return IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()] ?? null;
}

// Reads an image file into a base64 ImageInput, downsampling anything past
// the dimension cap. Returns null when the path is not a supported image or
// cannot be read.
export async function readImageInput(filePath: string, cwd: string): Promise<ImageInput | null> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) return null;
  const abs = path.resolve(cwd, filePath);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
  const buf = await readFile(abs).catch(() => null);
  if (!buf) return null;
  const result = await downsampleImageIfNeeded({
    path: filePath,
    mimeType,
    data: buf.toString("base64"),
  });
  return result.image;
}

export interface ParsedMentions {
  cleanText: string;
  mentions: string[];
}

// CJK ranges cover unified ideographs, Hangul syllables, compatibility
// ideographs and fullwidth forms so @中文文件名.md mentions parse. Keep in
// sync with the token charset path-suggest's extractAtToken accepts (\S).
const MENTION_RE =
  /(?<=^|\s)@([A-Za-z]:[\\/][A-Za-z0-9._\-/\\\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]*|[A-Za-z0-9._\-/\\\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+)/g;

export function parseMentions(text: string): ParsedMentions {
  const mentions: string[] = [];
  const seen = new Set<string>();
  const ranges: Array<[number, number]> = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const mention = match[1];
    const full = match[0];
    if (mention === undefined || full === undefined) continue;
    ranges.push([match.index, match.index + full.length]);
    if (!seen.has(mention)) {
      seen.add(mention);
      mentions.push(mention);
    }
  }
  if (ranges.length === 0) {
    return { cleanText: text, mentions };
  }
  let clean = "";
  let last = 0;
  for (const [start, end] of ranges) {
    clean += text.slice(last, start);
    last = end;
  }
  clean += text.slice(last);
  const cleanText = clean
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanText, mentions };
}

export interface MentionSkip {
  path: string;
  reason: string;
}

export interface ResolvedMentions {
  input: string;
  attached: string[];
  skipped: MentionSkip[];
  images: ImageInput[];
}

function isBinaryContent(buf: Buffer): boolean {
  const probe = buf.subarray(0, 8000);
  return probe.includes(0);
}

interface DirListState {
  lines: string[];
  shown: number;
  total: number;
  capped: boolean;
}

async function listDirEntries(
  dir: string,
  prefix: string,
  depth: number,
  state: DirListState,
  ignore: IgnorePredicate | undefined,
): Promise<void> {
  if (state.capped) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!entries) return;
  const visible = entries
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .filter((entry) => !(entry.isDirectory() && SKIP_DIRS.has(entry.name)))
    .filter((entry) => !isSensitivePath(entry.name))
    .filter((entry) => !ignore?.(path.join(dir, entry.name), entry.isDirectory()))
    .sort((a, b) => {
      const dirDiff = Number(b.isDirectory()) - Number(a.isDirectory());
      return dirDiff !== 0 ? dirDiff : a.name.localeCompare(b.name);
    });
  for (let i = 0; i < visible.length; i++) {
    if (state.total >= MAX_DIR_MENTION_TOTAL) {
      state.capped = true;
      return;
    }
    const entry = visible[i];
    if (!entry) continue;
    state.total += 1;
    const last = i === visible.length - 1;
    const isDir = entry.isDirectory();
    if (state.shown < MAX_DIR_MENTION_ENTRIES) {
      state.shown += 1;
      state.lines.push(`${prefix}${last ? "└── " : "├── "}${entry.name}${isDir ? "/" : ""}`);
      if (isDir && depth < MAX_DIR_MENTION_DEPTH) {
        await listDirEntries(
          path.join(dir, entry.name),
          `${prefix}${last ? "    " : "│   "}`,
          depth + 1,
          state,
          ignore,
        );
      }
    } else if (isDir && depth < MAX_DIR_MENTION_DEPTH) {
      await listDirEntries(path.join(dir, entry.name), prefix, depth + 1, state, ignore);
    }
  }
}

// Renders a directory mention as an indented tree block. Returns null when the
// directory cannot be read at all.
async function directoryBlock(
  abs: string,
  mention: string,
  ignore: IgnorePredicate | undefined,
): Promise<string | null> {
  const display = `${mention.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
  const state: DirListState = { lines: [`${display}`], shown: 0, total: 0, capped: false };
  const probe = await readdir(abs).catch(() => null);
  if (!probe) return null;
  await listDirEntries(abs, "", 1, state, ignore);
  if (state.capped) {
    state.lines.push("... (truncated, many more entries)");
  } else if (state.total > state.shown) {
    state.lines.push(
      `... (truncated, ${state.total - state.shown} more entries — use glob/grep tools or mention a subdirectory to see more)`,
    );
  }
  return `--- @${display} (directory) ---\n${state.lines.join("\n")}\n--- end ---`;
}

export async function resolveMentions(text: string, cwd: string): Promise<ResolvedMentions> {
  const { cleanText, mentions } = parseMentions(text);
  if (mentions.length === 0) {
    return { input: text, attached: [], skipped: [], images: [] };
  }
  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: MentionSkip[] = [];
  const images: ImageInput[] = [];
  let ignore: IgnorePredicate | null | undefined;
  for (const mention of mentions) {
    const abs = path.resolve(cwd, mention);
    if (isSensitivePath(abs)) {
      skipped.push({ path: mention, reason: "sensitive file" });
      continue;
    }
    const mimeType = imageMimeType(mention);
    if (mimeType) {
      const st = await stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        skipped.push({ path: mention, reason: st ? "is a directory" : "file not found" });
        continue;
      }
      if (st.size > MAX_IMAGE_BYTES) {
        skipped.push({ path: mention, reason: "image too large" });
        continue;
      }
      const buf = await readFile(abs).catch(() => null);
      if (!buf) {
        skipped.push({ path: mention, reason: "unreadable" });
        continue;
      }
      const result = await downsampleImageIfNeeded({
        path: mention,
        mimeType,
        data: buf.toString("base64"),
      });
      attached.push(mention);
      images.push(result.image);
      continue;
    }
    const st = await stat(abs).catch(() => null);
    if (!st) {
      skipped.push({ path: mention, reason: "file not found" });
      continue;
    }
    if (st.isDirectory()) {
      if (ignore === undefined) {
        ignore = createIgnorePredicate(cwd) ?? null;
      }
      const block = await directoryBlock(abs, mention, ignore ?? undefined);
      if (!block) {
        skipped.push({ path: mention, reason: "unreadable" });
        continue;
      }
      attached.push(mention);
      blocks.push(block);
      continue;
    }
    if (st.size > MAX_MENTION_BYTES) {
      skipped.push({ path: mention, reason: `exceeds ${MAX_MENTION_BYTES / 1024}KB limit` });
      continue;
    }
    const buf = await readFile(abs).catch(() => null);
    if (!buf) {
      skipped.push({ path: mention, reason: "unreadable" });
      continue;
    }
    if (isBinaryContent(buf)) {
      skipped.push({ path: mention, reason: "binary file" });
      continue;
    }
    attached.push(mention);
    blocks.push(`--- @${mention} ---\n${buf.toString("utf8")}\n--- end ---`);
  }
  const input = [cleanText, ...blocks].filter((s) => s.length > 0).join("\n\n") || text;
  return { input, attached, skipped, images };
}
