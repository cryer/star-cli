import type { CoreMessage } from "../core/messages";
import type { DisplayMessage } from "./components/MessageList";

export function summarizeArgs(args: unknown, maxLength = 120): string {
  let json: string;
  try {
    json = JSON.stringify(args) ?? String(args);
  } catch {
    json = String(args);
  }
  return json.length > maxLength ? `${json.slice(0, maxLength)}...` : json;
}

export function previewLines(text: string, maxLines = 10): { text: string; truncated: boolean } {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

export function coreMessageText(message: CoreMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join(" ");
  }
  return "";
}

export function buildDisplayMessages(messages: CoreMessage[]): DisplayMessage[] {
  const display: DisplayMessage[] = [];
  let collapsed = 0;
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant") {
      const text = coreMessageText(message);
      if (text) {
        display.push({ id: display.length, role: message.role, text });
      } else {
        collapsed++;
      }
    } else if (message.role === "tool") {
      collapsed++;
    }
  }
  if (collapsed > 0) {
    display.push({
      id: display.length,
      role: "system",
      text: `已恢复 ${collapsed} 条历史消息`,
    });
  }
  return display;
}
