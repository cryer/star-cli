import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const IMAGE_PART_TOKENS = 1024;

// CJK characters map to roughly one token each, while Latin text averages
// ~4 chars/token. Weight a CJK char as CHARS_PER_TOKEN units so the final
// division lands near 1 token/char — otherwise Chinese-heavy conversations
// are underestimated ~4x. Ranges: CJK punctuation, kana, ext-A, unified
// ideographs, compat ideographs, fullwidth forms.
const CJK_RE = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

function textWeight(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
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

export function estimateMessageTokens(message: CoreMessage): number {
  return (
    Math.ceil(contentCharLength(message) / CHARS_PER_TOKEN) +
    MESSAGE_OVERHEAD +
    imagePartCount(message) * IMAGE_PART_TOKENS
  );
}

export function estimateTokens(messages: CoreMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}
