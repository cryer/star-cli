import { Box, Text, useInput } from "ink";

export type ExitPlanDecision = "yes" | "no";

interface ExitPlanPromptProps {
  onDecision(decision: ExitPlanDecision): void;
}

export function ExitPlanPrompt({ onDecision }: ExitPlanPromptProps) {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y") onDecision("yes");
    else if (ch === "n" || key.escape) onDecision("no");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        Plan ready (plan mode)
      </Text>
      <Text>The plan above was produced without making any changes.</Text>
      <Text>[y] approve and execute [n] keep refining (Esc = n)</Text>
    </Box>
  );
}
