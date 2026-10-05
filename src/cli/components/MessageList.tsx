import { Box, Static, Text, useStdout } from "ink";
import { memo, useState } from "react";
import type { DiffLine } from "../diff-preview";
import { renderMarkdown } from "../markdown";
import { DiffLines } from "./DiffLines";

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
  // Set on the last chunk of a turn cut short with Esc: renders a dim
  // "[interrupted]" marker after the text. Display-only — the session store
  // carries its own marker (see AgentLoop.persistInterrupted).
  interrupted?: boolean;
  // Marks the synthetic placeholder entry that stands for the collapsed head
  // of an over-limit initial history: the number of entries it replaces.
  collapsed?: number;
}

const roleStyles: Record<
  Exclude<DisplayMessage["role"], "assistant-cont" | "user" | "tool">,
  { label: string; color: string }
> = {
  assistant: { label: "✦ star", color: "green" },
  system: { label: "● system", color: "yellow" },
};

const interruptedMarker = (text: string) => (
  <Text dimColor>{text.length > 0 ? " [interrupted]" : "[interrupted]"}</Text>
);

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

export const MessageList = memo(function MessageList({ messages }: { messages: DisplayMessage[] }) {
  const { stdout } = useStdout();
  const termWidth = stdout.columns ?? 80;
  // Captured once at mount: only the batch already present is eligible for
  // collapsing. Within one mount the list is append-only (wholesale rewrites
  // go through redrawMessages/applyMessages in repl.tsx, which bump the
  // epoch key and remount this component), so everything past the initial
  // length is a live-turn append and always renders in full.
  const [initial] = useState(() => ({
    length: messages.length,
    view: collapseInitialMessages(messages),
  }));
  const placeholder: DisplayMessage[] =
    initial.view.hidden > 0
      ? [{ id: -1, role: "system", text: "", collapsed: initial.view.hidden }]
      : [];
  const items = [...placeholder, ...initial.view.visible, ...messages.slice(initial.length)];
  return (
    <Static items={items}>
      {(message) => {
        if (message.collapsed !== undefined) {
          return (
            <Box key={message.id} flexDirection="column" marginBottom={1}>
              <Text dimColor>
                … {message.collapsed} earlier messages hidden — full history in the session file
              </Text>
            </Box>
          );
        }
        const marginBottom = message.tight ? 0 : 1;
        if (message.role === "assistant-cont") {
          return (
            <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
              <Text color="green">
                {renderMarkdown(message.text, "32", termWidth)}
                {message.interrupted && interruptedMarker(message.text)}
              </Text>
            </Box>
          );
        }
        if (message.role === "user") {
          return (
            <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
              <Box>
                <Text bold color="cyan">
                  {"❯ "}
                </Text>
                <Text color="cyan">
                  {message.text}
                  {message.interrupted && interruptedMarker(message.text)}
                </Text>
              </Box>
              {message.note && <Text dimColor> {message.note}</Text>}
            </Box>
          );
        }
        if (message.role === "tool") {
          // The card text carries its own tool icon + name header, so no
          // separate label line is needed.
          return (
            <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
              <Text color="magenta">{message.text}</Text>
              {message.diff && <DiffLines lines={message.diff} />}
            </Box>
          );
        }
        const style = roleStyles[message.role];
        return (
          <Box key={message.id} flexDirection="column" marginBottom={marginBottom}>
            <Text bold color={style.color}>
              {style.label}
            </Text>
            <Text color={style.color}>
              {message.role === "assistant"
                ? renderMarkdown(message.text, "32", termWidth)
                : message.text}
              {message.interrupted && interruptedMarker(message.text)}
            </Text>
            {message.diff && <DiffLines lines={message.diff} />}
            {message.note && <Text dimColor>{message.note}</Text>}
          </Box>
        );
      }}
    </Static>
  );
});
