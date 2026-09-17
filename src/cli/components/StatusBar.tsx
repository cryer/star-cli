import { Box, Text } from "ink";
import type { TokenUsage } from "../../core/events";

interface StatusBarProps {
  model: string;
  permissionMode: string;
  usage?: TokenUsage;
}

export function StatusBar({ model, permissionMode, usage }: StatusBarProps) {
  const tokens = usage ? `${usage.totalTokens} tokens` : "0 tokens";
  return (
    <Box justifyContent="space-between">
      <Text dimColor>model: {model}</Text>
      <Text dimColor>{tokens}</Text>
      <Text dimColor>mode: {permissionMode}</Text>
    </Box>
  );
}
