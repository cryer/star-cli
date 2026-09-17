import { Box, Text } from "ink";

interface StatusBarProps {
  model: string;
  permissionMode: string;
  tokens: number;
}

export function StatusBar({ model, permissionMode, tokens }: StatusBarProps) {
  return (
    <Box justifyContent="space-between">
      <Text dimColor>model: {model}</Text>
      <Text dimColor>{tokens} tokens</Text>
      <Text dimColor>mode: {permissionMode}</Text>
    </Box>
  );
}
