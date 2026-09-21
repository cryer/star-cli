import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ImageInput } from "../core/messages";
import { isSensitivePath } from "../tools/fs/util";

export const MAX_MENTION_BYTES = 100 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

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

// Reads an image file into a base64 ImageInput. Returns null when the path is
// not a supported image or cannot be read.
export async function readImageInput(filePath: string, cwd: string): Promise<ImageInput | null> {
  const mimeType = imageMimeType(filePath);
  if (!mimeType) return null;
  const abs = path.resolve(cwd, filePath);
  const st = await stat(abs).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
  const buf = await readFile(abs).catch(() => null);
  if (!buf) return null;
  return { path: filePath, mimeType, data: buf.toString("base64") };
}

export interface ParsedMentions {
  cleanText: string;
  mentions: string[];
}

const MENTION_RE = /(?<=^|\s)@([A-Za-z]:[\\/][A-Za-z0-9._\-/\\]*|[A-Za-z0-9._\-/\\]+)/g;

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

export async function resolveMentions(text: string, cwd: string): Promise<ResolvedMentions> {
  const { cleanText, mentions } = parseMentions(text);
  if (mentions.length === 0) {
    return { input: text, attached: [], skipped: [], images: [] };
  }
  const blocks: string[] = [];
  const attached: string[] = [];
  const skipped: MentionSkip[] = [];
  const images: ImageInput[] = [];
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
      attached.push(mention);
      images.push({ path: mention, mimeType, data: buf.toString("base64") });
      continue;
    }
    const st = await stat(abs).catch(() => null);
    if (!st) {
      skipped.push({ path: mention, reason: "file not found" });
      continue;
    }
    if (st.isDirectory()) {
      skipped.push({ path: mention, reason: "is a directory" });
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
