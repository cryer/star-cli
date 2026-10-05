import type { StreamEvent } from "../core/events";
import { formatStreamError, summarizeArgs } from "./format";

export interface PrintLine {
  stream: "stdout" | "stderr";
  text: string;
}

// Human-readable (-p without --json) rendering of one stream event. Tool
// args go through the same one-line summarizeArgs digest the REPL tool cards
// use instead of the full JSON; print-json (machine consumption) keeps the
// complete payload. Returns null for events this path ignores (reasoning,
// tool-call progress) — finish is accounted separately via UsageTracker and
// error additionally flips the exit code, both handled by the caller.
export function printEventLine(event: StreamEvent): PrintLine | null {
  switch (event.type) {
    case "text-delta":
      return { stream: "stdout", text: event.text };
    case "tool-call":
      return { stream: "stderr", text: `\n[tool] ${event.name} ${summarizeArgs(event.args)}\n` };
    case "tool-result": {
      const preview =
        event.content.length > 500
          ? `${event.content.slice(0, 500)}... (truncated)`
          : event.content;
      return {
        stream: "stderr",
        text: `[result] ${event.isError ? "ERROR: " : ""}${preview}\n`,
      };
    }
    case "retry": {
      const wait =
        event.delayMs !== undefined && event.delayMs >= 1000
          ? ` in ${Math.round(event.delayMs / 1000)}s`
          : "";
      return {
        stream: "stderr",
        text: `\n[retry ${event.attempt}/${event.maxAttempts}${wait}] ${event.reason}\n`,
      };
    }
    case "notice":
      return { stream: "stderr", text: `\n[notice] ${event.message}\n` };
    case "error":
      return { stream: "stderr", text: `\n[error] ${formatStreamError(event.error)}\n` };
    default:
      return null;
  }
}
