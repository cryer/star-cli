import type { CoreMessage } from "../core/messages";
import type { DisplayMessage } from "./components/MessageList";
import { committableLineCount } from "./markdown";
import { toTerminalSafe } from "./terminal-text";

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

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// Elapsed-time label for the thinking indicator: seconds while short, then
// the two largest units (1m5s, 1h2m3s) so long relay waits stay readable.
export function formatElapsedSeconds(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return `${minutes}m${secs}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m${secs}s`;
}

// Splits a streaming buffer into a committable head (complete lines) and a
// remainder, once the buffer holds at least minCompleteLines complete lines.
// The last line is always kept in the remainder: it may still be growing.
// The head is further capped at a markdown block boundary (never mid-table
// or mid-fence) because committed chunks render standalone in static history.
// Returns null when there is nothing worth committing yet.
export function splitCommittableLines(
  text: string,
  minCompleteLines: number,
): { committed: string; rest: string } | null {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return null;
  const complete = text.slice(0, lastNewline);
  const lines = complete.split("\n");
  const count = committableLineCount(lines);
  if (count < minCompleteLines) return null;
  const committed = lines.slice(0, count).join("\n");
  return { committed, rest: text.slice(committed.length + 1) };
}

export function formatStreamError(error: Error): string {
  if (error.message.includes("Unexpected end of JSON input")) {
    return `${error.message} (response stream was truncated — try again)`;
  }
  return error.message;
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
        // Restored history skips the streaming ingestion path, so escape it
        // here instead (idempotent — live-turn text is already normalized).
        display.push({ id: display.length, role: message.role, text: toTerminalSafe(text) });
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
      text: `Restored ${collapsed} history message(s) not shown here.`,
    });
  }
  return display;
}
