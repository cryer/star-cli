import { Box, Text, useStdout } from "ink";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffLine } from "../diff-preview";
import { cellWidth, renderMarkdown } from "../markdown";
import { toTerminalSafe } from "../terminal-text";

export interface DisplayMessage {
  id: number;
  role: "user" | "assistant" | "assistant-cont" | "system" | "tool";
  text: string;
  note?: string;
  // Structured diff lines (e.g. from /diff) rendered with per-line colors
  // below the message text instead of as one flat block.
  diff?: DiffLine[];
  // tight = no bottom margin; used for mid-turn continuation chunks so a
  // long streamed answer committed in pieces still reads as one block.
  tight?: boolean;
  // dim = render without the role color (folded one-line tool-call summaries
  // in restored history, which should recede behind the conversation text).
  dim?: boolean;
  // A user prompt steered into a running turn (the "insert now" submit
  // choice) instead of starting one: renders in a distinct color.
  steer?: boolean;
  // Set on the last chunk of a turn cut short with Esc: renders a dim
  // "[interrupted]" marker after the text. Display-only — the session store
  // carries its own marker (see AgentLoop.persistInterrupted).
  interrupted?: boolean;
  // Marks the synthetic placeholder entry that stands for the collapsed head
  // of an over-limit initial history: the number of entries it replaces.
  collapsed?: number;
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  magenta: "\u001B[35m",
  cyan: "\u001B[36m",
};

function styled(text: string, ...codes: string[]): string {
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function interruptedMarker(text: string): string {
  return styled(text.length > 0 ? " [interrupted]" : "[interrupted]", ANSI.dim);
}

function formatDiff(line: DiffLine): string {
  const text = toTerminalSafe(line.text);
  if (line.kind === "add") return styled(`+ ${text}`, ANSI.green);
  if (line.kind === "del") return styled(`- ${text}`, "\u001B[31m");
  return styled(line.kind === "marker" ? text : ` ${text}`, ANSI.dim);
}

export function formatDisplayMessage(message: DisplayMessage, termWidth = 80): string {
  const margin = message.tight ? "" : "\n";
  if (message.collapsed !== undefined) {
    return `${styled(`… ${message.collapsed} earlier messages hidden — full history in the session file`, ANSI.dim)}\n${margin}`;
  }
  const interrupted = message.interrupted ? interruptedMarker(message.text) : "";
  const note = message.note
    ? `\n${styled(message.role === "user" ? ` ${message.note}` : message.note, ANSI.dim)}`
    : "";
  const diff = message.diff?.length
    ? `\n${message.diff.map((line) => formatDiff(line)).join("\n")}`
    : "";
  if (message.role === "assistant-cont") {
    return `${styled(renderMarkdown(message.text, "32", termWidth) + interrupted, ANSI.green)}\n${margin}`;
  }
  if (message.role === "user") {
    const color = message.steer ? ANSI.magenta : ANSI.cyan;
    const prefix = styled(message.steer ? "» " : "❯ ", ANSI.bold, color);
    return `${prefix}${styled(message.text + interrupted, color)}${note}\n${margin}`;
  }
  if (message.role === "tool") {
    const text = message.dim ? styled(message.text, ANSI.dim) : styled(message.text, ANSI.magenta);
    return `${text}${diff}\n${margin}`;
  }
  const assistant = message.role === "assistant";
  const color = assistant ? ANSI.green : ANSI.yellow;
  const label = assistant ? "✦ star" : "● system";
  const text = assistant ? renderMarkdown(message.text, "32", termWidth) : message.text;
  return `${styled(label, ANSI.bold, color)}\n${styled(text + interrupted, color)}${diff}${note}\n${margin}`;
}

// How many entries of an initial (resumed) history batch render in full;
// anything older folds into a single placeholder line.
export const INITIAL_RENDER_LIMIT = 100;

export interface InitialHistoryView {
  // Entries folded into the placeholder line; 0 when the batch fits.
  hidden: number;
  // The batch entries rendered in full (the newest `limit` ones).
  visible: DisplayMessage[];
}

// Collapse view for the history batch present at mount: when it exceeds
// `limit`, everything but the newest `limit` entries is represented only by
// a count, so resuming a long session doesn't synchronously render (and
// markdown-format) thousands of entries or flood the scrollback.
export function collapseInitialMessages(
  messages: readonly DisplayMessage[],
  limit: number = INITIAL_RENDER_LIMIT,
): InitialHistoryView {
  if (messages.length <= limit) return { hidden: 0, visible: [...messages] };
  return { hidden: messages.length - limit, visible: messages.slice(-limit) };
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping generated SGR codes is the point
const ANSI_SGR_RE = /\u001B\[[0-9;]*m/g;

function formattedLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function lineRows(text: string, termWidth: number): number {
  return Math.max(1, Math.ceil(cellWidth(text.replace(ANSI_SGR_RE, "")) / termWidth));
}

interface TailStart {
  messageIndex: number;
  lineIndex: number;
}

function findTailStart(formatted: string[], maxLines: number, termWidth: number): TailStart {
  let usedRows = 0;
  for (let messageIndex = formatted.length - 1; messageIndex >= 0; messageIndex--) {
    const lines = formattedLines(formatted[messageIndex] ?? "");
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex--) {
      const rows = lineRows(lines[lineIndex] ?? "", termWidth);
      if (usedRows > 0 && usedRows + rows > maxLines) {
        return lineIndex + 1 < lines.length
          ? { messageIndex, lineIndex: lineIndex + 1 }
          : { messageIndex: messageIndex + 1, lineIndex: 0 };
      }
      usedRows += rows;
      if (usedRows >= maxLines) return { messageIndex, lineIndex };
    }
  }
  return { messageIndex: 0, lineIndex: 0 };
}

function sliceFormattedMessage(text: string, lineIndex: number, endLine?: number): string {
  if (lineIndex === 0 && endLine === undefined) return text;
  const lines = formattedLines(text);
  const prefix = lines.slice(0, lineIndex).join("\n");
  const lastReset = prefix.lastIndexOf(ANSI.reset);
  const activeStyles = prefix
    .slice(lastReset < 0 ? 0 : lastReset + ANSI.reset.length)
    .match(ANSI_SGR_RE)
    ?.join("");
  return `${activeStyles ?? ""}${lines.slice(lineIndex, endLine).join("\n")}\n${endLine === undefined ? "" : ANSI.reset}`;
}

function formattedRange(formatted: string[], start: TailStart, end: TailStart): string {
  if (start.messageIndex === end.messageIndex) {
    return start.lineIndex === end.lineIndex
      ? ""
      : sliceFormattedMessage(formatted[start.messageIndex] ?? "", start.lineIndex, end.lineIndex);
  }
  const chunks = [sliceFormattedMessage(formatted[start.messageIndex] ?? "", start.lineIndex)];
  for (let index = start.messageIndex + 1; index < end.messageIndex; index++) {
    chunks.push(formatted[index] ?? "");
  }
  if (end.lineIndex > 0) {
    chunks.push(sliceFormattedMessage(formatted[end.messageIndex] ?? "", 0, end.lineIndex));
  }
  return chunks.join("");
}

export const MessageList = memo(function MessageList({
  messages,
  termWidth = 80,
  maxLines,
}: {
  messages: DisplayMessage[];
  termWidth?: number;
  maxLines?: number;
}) {
  const { write } = useStdout();
  const [initial] = useState(() => ({
    length: messages.length,
    view: collapseInitialMessages(messages),
  }));
  const writtenRef = useRef<TailStart>({ messageIndex: 0, lineIndex: 0 });
  const writtenWidthRef = useRef(termWidth);
  const formattedRef = useRef(new Map<string, string>());
  const items = useMemo(() => {
    const placeholder: DisplayMessage[] =
      initial.view.hidden > 0
        ? [{ id: -1, role: "system", text: "", collapsed: initial.view.hidden }]
        : [];
    return [...placeholder, ...initial.view.visible, ...messages.slice(initial.length)];
  }, [initial, messages]);
  const formatted = items.map((message, index) => {
    const partiallyWritten =
      index === writtenRef.current.messageIndex && writtenRef.current.lineIndex > 0;
    const messageWidth = partiallyWritten ? writtenWidthRef.current : termWidth;
    const key = `${message.id}:${messageWidth}`;
    const cached = formattedRef.current.get(key);
    if (cached !== undefined) return cached;
    const value = formatDisplayMessage(message, messageWidth);
    formattedRef.current.set(key, value);
    return value;
  });

  const width = Math.max(1, termWidth);
  const visibleStart =
    maxLines === undefined
      ? { messageIndex: items.length, lineIndex: 0 }
      : findTailStart(formatted, maxLines, width);
  const written = writtenRef.current;
  const canArchive =
    visibleStart.messageIndex > written.messageIndex ||
    (visibleStart.messageIndex === written.messageIndex &&
      visibleStart.lineIndex > written.lineIndex);
  const historyEnd = canArchive ? visibleStart : written;
  useLayoutEffect(() => {
    const history = formattedRange(formatted, writtenRef.current, historyEnd);
    if (history === "") return;
    write(history);
    writtenRef.current = historyEnd;
    writtenWidthRef.current = termWidth;
  }, [formatted, historyEnd, termWidth, write]);

  if (maxLines === undefined || visibleStart.messageIndex === items.length) return null;
  return (
    <Box
      flexDirection="column"
      height={maxLines}
      flexShrink={0}
      overflowY="hidden"
      justifyContent="flex-end"
    >
      <Text>
        {formattedRange(formatted, visibleStart, { messageIndex: items.length, lineIndex: 0 })}
      </Text>
    </Box>
  );
});
