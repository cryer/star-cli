import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";

import { formatTokens } from "../cost";
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

// Rough CJK-aware chars→tokens estimate for the live thinking counter: the
// real BPE encoder is too heavy to run on a growing reasoning string every
// 100ms tick, so this mirrors the fallback rule in context/tokens.ts (CJK
// char ≈ 1 token, Latin ≈ 4 chars/token). Display-only; the provider's
// reported usage owns billing.
function roughReasoningTokens(text: string): number {
  let weight = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    weight +=
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
        ? 4
        : 1;
  }
  return Math.ceil(weight / 4);
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
  // elapsed time once it becomes relevant. Reasoning models add a live
  // thought-token counter so "thinking hard" is distinguishable from "stuck".
  const elapsedSec =
    startedAt === undefined ? undefined : Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const stats: string[] = [];
  if (elapsedSec !== undefined && elapsedSec >= 3) stats.push(formatElapsedSeconds(elapsedSec));
  const thoughtTokens = reasoning ? roughReasoningTokens(reasoning) : 0;
  if (thoughtTokens > 0) stats.push(`~${formatTokens(thoughtTokens)} thought`);
  const status = stats.length > 0 ? ` (${stats.join(" · ")})` : "";
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {spinner} {label}
        {status}
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
