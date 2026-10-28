import { useStdout } from "ink";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DiffLine } from "../diff-preview";
import { renderMarkdown } from "../markdown";
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

export const MessageList = memo(function MessageList({
  messages,
  termWidth = 80,
}: {
  messages: DisplayMessage[];
  termWidth?: number;
}) {
  const { write } = useStdout();
  const [initial] = useState(() => ({
    length: messages.length,
    view: collapseInitialMessages(messages),
  }));
  const writtenRef = useRef(0);
  const items = useMemo(() => {
    const placeholder: DisplayMessage[] =
      initial.view.hidden > 0
        ? [{ id: -1, role: "system", text: "", collapsed: initial.view.hidden }]
        : [];
    return [...placeholder, ...initial.view.visible, ...messages.slice(initial.length)];
  }, [initial, messages]);
  useLayoutEffect(() => {
    const pending = items.slice(writtenRef.current);
    if (pending.length === 0) return;
    writtenRef.current = items.length;
    write(pending.map((message) => formatDisplayMessage(message, termWidth)).join(""));
  }, [items, termWidth, write]);
  return null;
});
