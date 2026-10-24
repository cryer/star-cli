import type { StreamEvent } from "../core/events";
import { formatStreamError, summarizeArgs } from "./format";
import { toTerminalSafe } from "./terminal-text";

export interface PrintLine {
  stream: "stdout" | "stderr";
  text: string;
}

export interface PrintTtyOptions {
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
}

// Human-readable (-p without --json) rendering of one stream event. Tool
// args go through the same one-line summarizeArgs digest the REPL tool cards
// use instead of the full JSON; print-json (machine consumption) keeps the
// complete payload. Returns null for events this path ignores (reasoning,
// tool-call progress) — finish is accounted separately via UsageTracker and
// error additionally flips the exit code, both handled by the caller.
export function printEventLine(event: StreamEvent, tty: PrintTtyOptions = {}): PrintLine | null {
  let line: PrintLine | null;
  switch (event.type) {
    case "text-delta":
      line = { stream: "stdout", text: event.text };
      break;
    case "tool-call":
      line = { stream: "stderr", text: `\n[tool] ${event.name} ${summarizeArgs(event.args)}\n` };
      break;
    case "tool-result": {
      const preview =
        event.content.length > 500
          ? `${event.content.slice(0, 500)}... (truncated)`
          : event.content;
      line = {
        stream: "stderr",
        text: `[result] ${event.isError ? "ERROR: " : ""}${preview}\n`,
      };
      break;
    }
    case "retry": {
      const wait =
        event.delayMs !== undefined && event.delayMs >= 1000
          ? ` in ${Math.round(event.delayMs / 1000)}s`
          : "";
      line = {
        stream: "stderr",
        text: `\n[retry ${event.attempt}/${event.maxAttempts}${wait}] ${event.reason}\n`,
      };
      break;
    }
    case "notice":
      line = { stream: "stderr", text: `\n[notice] ${event.message}\n` };
      break;
    case "error":
      line = { stream: "stderr", text: `\n[error] ${formatStreamError(event.error)}\n` };
      break;
    default:
      return null;
  }
  const isTTY =
    line.stream === "stdout"
      ? (tty.stdoutIsTTY ?? Boolean(process.stdout.isTTY))
      : (tty.stderrIsTTY ?? Boolean(process.stderr.isTTY));
  return isTTY ? { ...line, text: toTerminalSafe(line.text) } : line;
}
