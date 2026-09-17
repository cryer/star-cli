import type { CoreMessage } from "../core/messages";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

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

export function estimateMessageTokens(message: CoreMessage): number {
  return Math.ceil(contentCharLength(message) / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
}

export function estimateTokens(messages: CoreMessage[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}
