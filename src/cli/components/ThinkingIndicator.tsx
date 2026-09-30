import { Box, Text } from "ink";

import { formatElapsedSeconds } from "../format";
import { thinkingIcon } from "../icons";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const REASONING_TAIL_LENGTH = 200;
export const THOUGHT_SUMMARY_LENGTH = 100;

export function truncateTail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max)}`;
}

// The spinner frame is driven by the caller's render ticker (see cli/ticker.ts);
// keeping no internal interval avoids a second full-tree Ink rewrite per frame.
// `activity` replaces the default label, e.g. while a tool call is executing.
export function ThinkingIndicator({
  reasoning,
  frame = 0,
  activity,
  elapsedSec,
}: { reasoning?: string; frame?: number; activity?: string; elapsedSec?: number }) {
  const tail = reasoning ? truncateTail(reasoning, REASONING_TAIL_LENGTH) : "";
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  // Tool-running activities carry their own per-tool icon in the label
  // (see repl.tsx), so the 💭 prefix only applies while thinking.
  const label = activity ?? `${thinkingIcon} star is thinking…`;
  // Long buffered waits (slow relays) look dead without a clock; show the
  // elapsed time once it becomes relevant.
  const elapsed =
    elapsedSec !== undefined && elapsedSec >= 3 ? ` (${formatElapsedSeconds(elapsedSec)})` : "";
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {spinner} {label}
        {elapsed}
      </Text>
      {tail !== "" && (
        <Text dimColor>
          {"   "}
          {tail}
        </Text>
      )}
    </Box>
  );
}
