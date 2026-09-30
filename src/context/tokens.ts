import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const IMAGE_PART_TOKENS = 1024;

// CJK characters map to roughly one token each, while Latin text averages
// ~4 chars/token. Weight a CJK char as CHARS_PER_TOKEN units so the final
// division lands near 1 token/char — otherwise Chinese-heavy conversations
// are underestimated ~4x. Ranges: CJK punctuation, kana, ext-A, unified
// ideographs, compat ideographs, fullwidth forms. Numeric code-unit
// comparisons instead of a per-char regex: several times faster on the long
// tool-result strings this runs over, with identical results (surrogate
// halves never fall in these ranges).
function isCjkCode(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x30ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

function textWeight(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    if (isCjkCode(text.charCodeAt(i))) cjk++;
  }
  return text.length + cjk * (CHARS_PER_TOKEN - 1);
}

function contentCharLength(message: CoreMessage): number {
  if (message.role === "tool") {
    let chars = 0;
    for (const part of message.content) {
      chars += textWeight(JSON.stringify(part.result ?? null));
    }
    return chars;
  }
  if (typeof message.content === "string") {
    return textWeight(message.content);
  }
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += textWeight(part.text);
    } else if (part.type === "tool-call") {
      chars += textWeight(part.toolName) + textWeight(JSON.stringify(part.args ?? null));
    }
  }
  return chars;
}

function imagePartCount(message: CoreMessage): number {
  if (typeof message.content === "string" || message.role === "tool") return 0;
  return message.content.filter((part) => part.type === "image" || part.type === "file").length;
}

// Messages are immutable once they enter a loop's history (the system
// message slot is replaced, never edited in place — see syncSystemMessage
// in agent/loop.ts), so an identity-keyed cache never serves a stale count.
// The agent loop re-estimates the whole history every step; caching per
// message object keeps that O(new messages) instead of O(history), and the
// JSON.stringify of big tool results/args in contentCharLength runs once
// per message instead of once per step.
const tokenCache = new WeakMap<CoreMessage, number>();

export function estimateMessageTokens(message: CoreMessage): number {
  const cached = tokenCache.get(message);
  if (cached !== undefined) return cached;
  const tokens =
    Math.ceil(contentCharLength(message) / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD +
    imagePartCount(message) * IMAGE_PART_TOKENS;
  tokenCache.set(message, tokens);
  return tokens;
}

export function estimateTokens(messages: CoreMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}
