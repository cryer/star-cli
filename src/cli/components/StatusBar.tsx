import { Box, Text } from "ink";
import { memo } from "react";

interface StatusBarProps {
  model: string;
  permissionMode: string;
  tokens: number;
  // Labels of currently running background tasks (description or command).
  backgroundTasks?: string[];
}

const BG_LABEL_MAX = 40;

export const StatusBar = memo(function StatusBar({
  model,
  permissionMode,
  tokens,
  backgroundTasks = [],
}: StatusBarProps) {
  const joined = backgroundTasks.join(", ");
  const labels = joined.length > BG_LABEL_MAX ? `${joined.slice(0, BG_LABEL_MAX)}…` : joined;
  return (
    <Box justifyContent="space-between">
      <Text dimColor>model: {model}</Text>
      {backgroundTasks.length > 0 && (
        <Text color="yellow">
          bg: {backgroundTasks.length} ({labels})
        </Text>
      )}
      <Text dimColor>{tokens} tokens</Text>
      <Text dimColor>mode: {permissionMode}</Text>
    </Box>
  );
});
