import { Box, Text } from "ink";
import { memo } from "react";

interface StatusBarProps {
  model: string;
  permissionMode: string;
  tokens: number;
  backgroundTasks?: number;
}

export const StatusBar = memo(function StatusBar({
  model,
  permissionMode,
  tokens,
  backgroundTasks = 0,
}: StatusBarProps) {
  return (
    <Box justifyContent="space-between">
      <Text dimColor>model: {model}</Text>
      {backgroundTasks > 0 && <Text dimColor>bg: {backgroundTasks}</Text>}
      <Text dimColor>{tokens} tokens</Text>
      <Text dimColor>mode: {permissionMode}</Text>
    </Box>
  );
});
