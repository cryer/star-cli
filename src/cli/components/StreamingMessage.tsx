import { Box, Text } from "ink";
import { memo } from "react";

export const StreamingMessage = memo(function StreamingMessage({
  text,
  continuation,
}: { text: string; continuation?: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {!continuation && (
        <Text bold color="green">
          star
        </Text>
      )}
      <Text color="green">{text}</Text>
    </Box>
  );
});
