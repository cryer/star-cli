import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
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

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

export function formatSessionEntries(
  entries: SessionListEntry[],
  options: { showCwd?: boolean } = {},
): string {
  return entries
    .map(({ meta, messageCount }) => {
      const title = meta.title || "(无标题)";
      const base =
        `${shortSessionId(meta.id)}  ${title}  ` +
        `${messageCount} 条消息  更新于 ${relativeTime(meta.updatedAt)}`;
      return options.showCwd ? `${base}  [${meta.cwd}]` : base;
    })
    .join("\n");
}
