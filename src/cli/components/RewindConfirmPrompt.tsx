import { Box, Text, useInput } from "ink";

export type RewindDecision = "yes" | "no";

interface RewindConfirmPromptProps {
  summary: string;
  onDecision(decision: RewindDecision): void;
}

export function RewindConfirmPrompt({ summary, onDecision }: RewindConfirmPromptProps) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") onDecision("yes");
    else if (ch === "n" || key.escape) onDecision("no");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Rewind checkpoints
      </Text>
      <Text>{summary}</Text>
      <Text>[y] rewind [n] cancel (Esc = n)</Text>
    </Box>
  );
}
