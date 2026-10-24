import { Box, Text } from "ink";
import { memo, useEffect, useRef, useState } from "react";

import { formatTokens } from "../cost";
import { formatElapsedSeconds } from "../format";
import { thinkingIcon } from "../icons";
import { isMotionDisabled, startTicker } from "../ticker";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const REASONING_TAIL_LENGTH = 200;
export const THOUGHT_SUMMARY_LENGTH = 100;

export interface ReasoningDisplayCache {
  max: number;
  text: string;
  weight: number;
  flatLength: number;
  flatTail: string;
  hasContent: boolean;
  pendingSpace: boolean;
}

export function createReasoningDisplayCache(max = REASONING_TAIL_LENGTH): ReasoningDisplayCache {
  return {
    max,
    text: "",
    weight: 0,
    flatLength: 0,
    flatTail: "",
    hasContent: false,
    pendingSpace: false,
  };
}

function appendFlat(cache: ReasoningDisplayCache, text: string): void {
  cache.flatLength += 1;
  cache.flatTail = `${cache.flatTail}${text}`.slice(-cache.max);
}

export function updateReasoningDisplay(cache: ReasoningDisplayCache, text: string) {
  if (text !== cache.text) {
    if (!text.startsWith(cache.text)) {
      cache.text = "";
      cache.weight = 0;
      cache.flatLength = 0;
      cache.flatTail = "";
      cache.hasContent = false;
      cache.pendingSpace = false;
    }
    const appended = text.slice(cache.text.length);
    for (let i = 0; i < appended.length; i++) {
      const ch = appended[i] ?? "";
      const code = ch.charCodeAt(0);
      cache.weight +=
        (code >= 0x3000 && code <= 0x30ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xff00 && code <= 0xffef)
          ? 4
          : 1;
      if (/\s/.test(ch)) {
        cache.pendingSpace = cache.hasContent;
      } else {
        if (cache.pendingSpace) appendFlat(cache, " ");
        appendFlat(cache, ch);
        cache.hasContent = true;
        cache.pendingSpace = false;
      }
    }
    cache.text = text;
  }
  return {
    tail: cache.flatLength <= cache.max ? cache.flatTail : `…${cache.flatTail}`,
    thoughtTokens: Math.ceil(cache.weight / 4),
  };
}

export function truncateTail(text: string, max: number): string {
  return updateReasoningDisplay(createReasoningDisplayCache(max), text).tail;
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
  const noMotion = isMotionDisabled();
  useEffect(() => {
    if (noMotion) return;
    return startTicker((t) => setTick(t));
  }, [noMotion]);
  const cacheRef = useRef(createReasoningDisplayCache());
  const display = updateReasoningDisplay(cacheRef.current, reasoning ?? "");
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
  if (display.thoughtTokens > 0) stats.push(`~${formatTokens(display.thoughtTokens)} thought`);
  const status = stats.length > 0 ? ` (${stats.join(" · ")})` : "";
  return (
    <Box flexDirection="column">
      <Text dimColor>
        {spinner} {label}
        {status}
      </Text>
      {display.tail !== "" && (
        <Text dimColor>
          {"   "}
          {display.tail}
        </Text>
      )}
    </Box>
  );
});
