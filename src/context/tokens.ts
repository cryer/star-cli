import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;
const IMAGE_PART_TOKENS = 1024;

function contentCharLength(message: CoreMessage): number {
  if (message.role === "tool") {
    let chars = 0;
    for (const part of message.content) {
      chars += JSON.stringify(part.result ?? null).length;
    }
    return chars;
  }
  if (typeof message.content === "string") {
    return message.content.length;
  }
  let chars = 0;
  for (const part of message.content) {
    if (part.type === "text" || part.type === "reasoning") {
      chars += part.text.length;
    } else if (part.type === "tool-call") {
      chars += part.toolName.length + JSON.stringify(part.args ?? null).length;
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
