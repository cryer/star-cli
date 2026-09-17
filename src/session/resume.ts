import type { CoreMessage } from "../core/messages";
import { type SessionMeta, SessionStore } from "./store";

export async function resumeSession(
  id: string,
): Promise<{ meta: SessionMeta; messages: CoreMessage[] } | null> {
  const store = await SessionStore.open(id);
  if (!store) return null;
  const [meta, messages] = await Promise.all([store.meta(), store.messages()]);
  return { meta, messages };
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

export function formatSessionList(metas: SessionMeta[]): string {
  return metas
    .map((meta) => {
      const title = meta.title || "(无标题)";
      return `${meta.id}  ${title}  (更新于 ${relativeTime(meta.updatedAt)})`;
    })
    .join("\n");
}
