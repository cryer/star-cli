import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionsDir } from "../config/paths";
import type { CoreMessage } from "../core/messages";
import { relativeTime, shortSessionId } from "./list";
import { type SessionMeta, SessionStore } from "./store";

export interface SessionSearchHit {
  meta: SessionMeta;
  snippet: string;
}

const SNIPPET_LENGTH = 100;

// Histories are scanned in fixed-size chunks through a StringDecoder — the
// same pattern as SessionStore.starMessages — so a search never buffers a
// whole messages.jsonl the way the old read-everything implementation did.
const SEARCH_READ_CHUNK_BYTES = 64 * 1024;

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

// Streams a session's flattened message texts line by line (blank and corrupt
// jsonl lines skipped, empty pieces dropped — the same haystack the old
// map(flatten).filter(non-empty).join("\n") built). Returning true from
// onPiece stops the scan and closes the file without reading the rest. An
// unreadable file scans as an empty session.
async function streamSessionPieces(id: string, onPiece: (piece: string) => boolean): Promise<void> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(path.join(sessionsDir(), id, "messages.jsonl"), "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(SEARCH_READ_CHUNK_BYTES);
    let tail = "";
    let stop = false;
    const pushLine = (line: string) => {
      if (stop) return;
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: CoreMessage;
      try {
        message = JSON.parse(trimmed) as CoreMessage;
      } catch {
        return; // corrupt line — skipped, same as starMessages
      }
      const piece = flattenMessage(message);
      if (piece !== "") stop = onPiece(piece);
    };
    while (!stop) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const chunk = tail + decoder.write(buffer.subarray(0, bytesRead));
      const lines = chunk.split("\n");
      tail = lines.pop() ?? "";
      for (const line of lines) pushLine(line);
    }
    if (!stop) pushLine(tail + decoder.end());
  } catch {
    // Missing or unreadable messages.jsonl — nothing to scan.
  } finally {
    await handle?.close().catch(() => {});
  }
}

// First pass: answers the old `text.toLowerCase().includes(needle)` hit rule
// while holding only a needle-sized tail of the lowercased stream (the tail
// keeps matches crossing the "\n" message joiner detectable). Most sessions
// don't match, so this is where the memory win is; the few matching sessions
// are re-read by the snippet pass.
async function sessionTextContains(id: string, needle: string): Promise<boolean> {
  let lowerTail = "";
  let found = false;
  let joined = false;
  await streamSessionPieces(id, (piece) => {
    const segment = joined ? `\n${piece}` : piece;
    joined = true;
    const haystack = lowerTail + segment.toLowerCase();
    lowerTail = needle.length > 1 ? haystack.slice(1 - needle.length) : "";
    if (haystack.includes(needle)) {
      found = true;
      return true;
    }
    return false;
  });
  return found;
}

// Second pass: rebuilds the old full-read snippet byte-exactly. Pieces are
// accumulated only until the snippet window is provably complete — the
// collapsed text outgrows the first match by SNIPPET_LENGTH — then the scan
// stops and the rest of the file is never read. A needle that can never
// appear in whitespace-collapsed text (it contains a whitespace run itself)
// makes makeSnippet fall back to the head of the collapsed text, so there the
// scan runs to EOF instead of exiting early.
async function buildSessionSnippet(id: string, needle: string, query: string): Promise<string> {
  const parts: string[] = [];
  let lowerTail = "";
  let mode: "scan" | "window" | "head" = needle === "" ? "window" : "scan";
  // Collapsed-prefix bookkeeping for "window" mode: makeSnippet collapses and
  // trims the whole text before locating the match, so the window is known to
  // be complete once the collapsed prefix outgrows the match end enough.
  let flatLength = 0;
  let flatLastChar = "";
  let matchEndFlat = 0;
  let stoppedEarly = false;

  // Folds one more raw segment into the collapsed-prefix counters. The
  // collapse of any prefix is itself a prefix of the full collapse, so the
  // boundary needs only the previous collapsed char.
  const foldCollapsed = (segment: string) => {
    let folded = (flatLastChar + segment).replace(/\s+/g, " ");
    if (flatLength === 0) {
      // makeSnippet trims the collapsed text — a leading run never counts.
      if (folded.startsWith(" ")) folded = folded.slice(1);
    } else {
      folded = folded.slice(1); // flatLastChar was already counted
    }
    flatLength += folded.length;
    if (folded.length > 0) flatLastChar = folded.at(-1) ?? "";
  };

  await streamSessionPieces(id, (piece) => {
    const segment = parts.length === 0 ? piece : `\n${piece}`;
    parts.push(piece);
    if (mode === "scan") {
      const haystack = lowerTail + segment.toLowerCase();
      lowerTail = needle.length > 1 ? haystack.slice(1 - needle.length) : "";
      if (!haystack.includes(needle)) return false;
      const collapsed = parts.join("\n").replace(/\s+/g, " ").replace(/^ /, "");
      const index = collapsed.toLowerCase().indexOf(needle);
      if (index === -1) {
        mode = "head";
        return false;
      }
      mode = "window";
      matchEndFlat = index + needle.length;
      flatLength = collapsed.length;
      flatLastChar = collapsed.at(-1) ?? "";
    } else if (mode === "window") {
      foldCollapsed(segment);
    }
    const stop = mode === "window" && flatLength > matchEndFlat + SNIPPET_LENGTH;
    if (stop) stoppedEarly = true;
    return stop;
  });

  const text = parts.join("\n");
  // A mid-file stop must keep makeSnippet's trailing "…" even when the
  // accumulated prefix ends in whitespace (whose collapsed run would trim
  // away and hide the unread continuation): one non-whitespace sentinel
  // stands in for that remainder. It can never enter the ≤100-char window —
  // the scan only stops once the window end is strictly inside the prefix.
  return makeSnippet(stoppedEarly ? `${text}\0` : text, query);
}

// Full-text search across every stored session, most recently updated first.
// Sessions are scanned one at a time with the two streaming passes above, and
// scanning stops entirely once `limit` hits are collected — neither memory
// nor IO grows with the number or size of stored histories. Unreadable
// sessions and corrupt jsonl lines are skipped silently.
export async function searchSessions(query: string, limit = 10): Promise<SessionSearchHit[]> {
  const hits: SessionSearchHit[] = [];
  const needle = query.toLowerCase();
  for (const meta of await SessionStore.list()) {
    if (hits.length >= limit) break;
    if (needle !== "" && !(await sessionTextContains(meta.id, needle))) continue;
    hits.push({ meta, snippet: await buildSessionSnippet(meta.id, needle, query) });
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
