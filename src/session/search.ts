import type { CoreMessage } from "../core/messages";
import { relativeTime, shortSessionId } from "./list";
import { type SessionMeta, SessionStore } from "./store";

export interface SessionSearchHit {
  meta: SessionMeta;
  snippet: string;
}

const SNIPPET_LENGTH = 100;

function flattenMessage(message: CoreMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "tool-call") {
      parts.push(JSON.stringify(part.args));
    } else if (part.type === "tool-result") {
      parts.push(typeof part.result === "string" ? part.result : JSON.stringify(part.result));
    }
  }
  return parts.join("\n");
}

// ~100 chars of the (whitespace-collapsed) haystack centered on the first
// case-insensitive match, with … markers where text was cut off.
function makeSnippet(text: string, query: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const index = flat.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1 || flat.length <= SNIPPET_LENGTH) return flat.slice(0, SNIPPET_LENGTH);
  const side = Math.max(0, Math.floor((SNIPPET_LENGTH - query.length) / 2));
  let start = Math.max(0, index - side);
  const end = Math.min(flat.length, start + SNIPPET_LENGTH);
  start = Math.max(0, end - SNIPPET_LENGTH);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

// Full-text search across every stored session, most recently updated first.
// Unreadable sessions and corrupt jsonl lines are skipped silently.
export async function searchSessions(query: string, limit = 10): Promise<SessionSearchHit[]> {
  const hits: SessionSearchHit[] = [];
  const needle = query.toLowerCase();
  for (const meta of await SessionStore.list()) {
    if (hits.length >= limit) break;
    const store = await SessionStore.open(meta.id);
    if (!store) continue;
    const text = (await store.messages())
      .map(flattenMessage)
      .filter((part) => part.length > 0)
      .join("\n");
    if (text.toLowerCase().includes(needle)) {
      hits.push({ meta, snippet: makeSnippet(text, query) });
    }
  }
  return hits;
}

export function formatSearchResults(hits: SessionSearchHit[], query: string): string {
  if (hits.length === 0) return `No sessions matching "${query}".`;
  const lines = hits.map(({ meta, snippet }) => {
    const title = meta.title || "(untitled)";
    return `${shortSessionId(meta.id)}  ${title}  (${relativeTime(meta.updatedAt)})\n    ${snippet}`;
  });
  return [...lines, "Resume with /resume <id>"].join("\n");
}
