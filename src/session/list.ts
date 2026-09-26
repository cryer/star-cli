import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
import type { CoreMessage } from "../core/messages";
import { type SessionMeta, SessionStore } from "./store";

export interface SessionListEntry {
  meta: SessionMeta;
  messageCount: number;
}

async function countMessages(id: string): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionsDir(), id, "messages.jsonl"), "utf8");
  } catch {
    return 0;
  }
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim()) count += 1;
  }
  return count;
}

export async function listSessionEntries(cwd?: string): Promise<SessionListEntry[]> {
  const metas = await SessionStore.list(cwd);
  return Promise.all(
    metas.map(async (meta) => ({ meta, messageCount: await countMessages(meta.id) })),
  );
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
