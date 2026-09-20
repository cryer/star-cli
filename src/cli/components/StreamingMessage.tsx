import { Box, Text } from "ink";
import { memo } from "react";

export const StreamingMessage = memo(function StreamingMessage({ text }: { text: string }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color="green">
        star
      </Text>
      <Text color="green">{text}</Text>
    </Box>
  );
});
