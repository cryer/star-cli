import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
import type { CoreMessage } from "../core/messages";
import { type SessionMeta, SessionStore } from "./store";

export interface SessionListEntry {
  meta: SessionMeta;
  messageCount: number;
}

// Counts newline-terminated records in fixed-size chunks instead of reading
// the whole file: listSessionEntries runs this for every session, so
// `star -r` and the /resume picker used to load every full history just for
// the row's message count. "\n" (0x0A) never appears inside a multi-byte
// UTF-8 sequence, so a raw byte scan is safe. Lines are written as compact
// JSON (no raw whitespace), and a blank or whitespace-only fragment is not
// counted — same semantics as the old readFile + split counter.
const COUNT_CHUNK_BYTES = 64 * 1024;

async function countMessages(id: string): Promise<number> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path.join(sessionsDir(), id, "messages.jsonl"), "r");
    const buffer = Buffer.alloc(COUNT_CHUNK_BYTES);
    let count = 0;
    let lineHasContent = false;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, COUNT_CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      for (const byte of buffer.subarray(0, bytesRead)) {
        if (byte === 0x0a) {
          if (lineHasContent) count += 1;
          lineHasContent = false;
        } else if (byte !== 0x0d && byte !== 0x20 && byte !== 0x09) {
          lineHasContent = true;
        }
      }
    }
    if (lineHasContent) count += 1;
    return count;
  } catch {
    return 0;
  } finally {
    await handle?.close().catch(() => {});
  }
}

// Caps how many messages.jsonl files countMessages holds open at once:
// mapping over every session with Promise.all opens one handle per session
// concurrently, and a few hundred stored sessions reliably trip EMFILE/EPERM
// on Windows. Order is preserved — workers claim indices, not slots.
const LIST_COUNT_CONCURRENCY = 8;

export async function listSessionEntries(cwd?: string): Promise<SessionListEntry[]> {
  const metas = await SessionStore.list(cwd);
  const entries: SessionListEntry[] = [];
  let next = 0;
  const worker = async () => {
    while (next < metas.length) {
      const index = next;
      next += 1;
      const meta = metas[index];
      if (!meta) continue;
      entries[index] = { meta, messageCount: await countMessages(meta.id) };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LIST_COUNT_CONCURRENCY, metas.length) }, () => worker()),
  );
  return entries;
}

export async function findLatestSession(cwd: string): Promise<SessionMeta | null> {
  const [latest] = await SessionStore.list(cwd);
  return latest ?? null;
}

// Reads only the head of messages.jsonl and extracts the first user message's
// text, whitespace-collapsed onto one line — the /resume picker needs a
// preview per session and must not parse every full history for it. The final
// partial line at the read boundary and any corrupt lines are skipped.
// Returns null when no user text is found (or the file is unreadable).
export async function sessionPreview(id: string, maxBytes = 4096): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path.join(sessionsDir(), id, "messages.jsonl"), "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const head = buffer.toString("utf8", 0, bytesRead);
    for (const line of head.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const message = JSON.parse(trimmed) as CoreMessage;
        if (message.role !== "user") continue;
        const text =
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => (part.type === "text" ? part.text : ""))
                .join(" ");
        const collapsed = text.replace(/\s+/g, " ").trim();
        if (collapsed) return collapsed;
      } catch {
        // Half line at the read boundary or a corrupt line — keep looking.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function shortSessionId(id: string): string {
  const dash = id.lastIndexOf("-");
  return dash === -1 ? id : id.slice(dash + 1);
}

export async function resolveSessionId(query: string): Promise<string | null> {
  const metas = await SessionStore.list();
  const exact = metas.find((meta) => meta.id === query);
  if (exact) return exact.id;
  const matches = metas.filter(
    (meta) => shortSessionId(meta.id) === query || meta.id.startsWith(query),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function formatSessionEntries(
  entries: SessionListEntry[],
  options: { showCwd?: boolean } = {},
): string {
  return entries
    .map(({ meta, messageCount }) => {
      const title = meta.title || "(untitled)";
      const base =
        `${shortSessionId(meta.id)}  ${title}  ` +
        `${messageCount} messages  updated ${relativeTime(meta.updatedAt)}`;
      return options.showCwd ? `${base}  [${meta.cwd}]` : base;
    })
    .join("\n");
}
