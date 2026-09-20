import { Box, Text } from "ink";
import { useEffect, useState } from "react";

export const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const FRAME_INTERVAL_MS = 100;
export const REASONING_TAIL_LENGTH = 200;
export const THOUGHT_SUMMARY_LENGTH = 100;

export function truncateTail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `…${flat.slice(flat.length - max)}`;
}

export function ThinkingIndicator({ reasoning }: { reasoning?: string }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      FRAME_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, []);
  const tail = reasoning ? truncateTail(reasoning, REASONING_TAIL_LENGTH) : "";
  return (
    <Box flexDirection="column">
      <Text dimColor>{SPINNER_FRAMES[frame]} star is thinking…</Text>
      {tail !== "" && <Text dimColor> {tail}</Text>}
    </Box>
  );
}
