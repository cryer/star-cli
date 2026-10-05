import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";

import { formatElapsedSeconds } from "../format";
import { thinkingIcon } from "../icons";
import { startTicker } from "../ticker";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const REASONING_TAIL_LENGTH = 200;
export const THOUGHT_SUMMARY_LENGTH = 100;

export function truncateTail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max)}`;
}

// The spinner animates from the component's own ticker (see cli/ticker.ts):
// the indicator is mounted only while a turn or a busy command is in flight,
// so the 100ms frame re-render stays inside this component instead of
// setState-ing the Repl root (and reconciling the whole tree) on every frame.
// Unmounting stops the interval. `frame` pins a fixed frame and wins over the
// animated one; `activity` replaces the default label, e.g. while a tool call
// is executing; `startedAt` (ms timestamp) drives the elapsed clock.
export const ThinkingIndicator = memo(function ThinkingIndicator({
  reasoning,
  frame,
  activity,
  startedAt,
}: { reasoning?: string; frame?: number; activity?: string; startedAt?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => startTicker((t) => setTick(t)), []);
  const tail = reasoning ? truncateTail(reasoning, REASONING_TAIL_LENGTH) : "";
  const spinner = SPINNER_FRAMES[(frame ?? tick) % SPINNER_FRAMES.length];
  // Tool-running activities carry their own per-tool icon in the label
  // (see repl.tsx), so the 💭 prefix only applies while thinking.
  const label = activity ?? `${thinkingIcon} star is thinking…`;
  // Long buffered waits (slow relays) look dead without a clock; show the
  // elapsed time once it becomes relevant.
  const elapsedSec =
    startedAt === undefined ? undefined : Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
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
});
