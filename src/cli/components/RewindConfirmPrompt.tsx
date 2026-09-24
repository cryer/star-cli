import { Box, Text, useInput } from "ink";
import type { DiffLine } from "../diff-preview";
import { DiffLines } from "./DiffLines";

export type RewindDecision = "yes" | "no";

export interface ConfirmDiff {
  label: string;
  lines: DiffLine[];
}

interface RewindConfirmPromptProps {
  summary: string;
  title?: string;
  confirmLabel?: string;
  diffs?: ConfirmDiff[];
  onDecision(decision: RewindDecision): void;
}

export function RewindConfirmPrompt({
  summary,
  title = "Rewind checkpoints",
  confirmLabel = "rewind",
  diffs,
  onDecision,
}: RewindConfirmPromptProps) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") onDecision("yes");
    else if (ch === "n" || key.escape) onDecision("no");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        {title}
      </Text>
      <Text>{summary}</Text>
      {diffs?.map((diff) => (
        <Box key={diff.label} flexDirection="column">
          <Text dimColor>{diff.label}</Text>
          <DiffLines lines={diff.lines} />
        </Box>
      ))}
      <Text>[y] {confirmLabel} [n] cancel (Esc = n)</Text>
    </Box>
  );
}
