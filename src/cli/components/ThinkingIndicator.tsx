import { Box, Text } from "ink";

export const SPINNER_FRAMES = ["-", "\\", "|", "/"];
export const REASONING_TAIL_LENGTH = 200;
export const THOUGHT_SUMMARY_LENGTH = 100;

export function truncateTail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max)}`;
}

// The spinner frame is driven by the caller's render ticker (see cli/ticker.ts);
// keeping no internal interval avoids a second full-tree Ink rewrite per frame.
export function ThinkingIndicator({
  reasoning,
  frame = 0,
}: { reasoning?: string; frame?: number }) {
  const tail = reasoning ? truncateTail(reasoning, REASONING_TAIL_LENGTH) : "";
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  return (
    <Box flexDirection="column">
      <Text dimColor>{spinner} star is thinking…</Text>
      {tail !== "" && <Text dimColor> {tail}</Text>}
    </Box>
  );
}
