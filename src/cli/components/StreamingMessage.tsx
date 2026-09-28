import { Box, Text } from "ink";
import { memo } from "react";
import { renderMarkdown } from "../markdown";

export const StreamingMessage = memo(function StreamingMessage({
  text,
  continuation,
}: { text: string; continuation?: boolean }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {!continuation && (
        <Text bold color="green">
          ✦ star
        </Text>
      )}
      {/* The outer green stays: styled spans reset and re-open the base color. */}
      <Text color="green">{renderMarkdown(text, "32")}</Text>
    </Box>
  );
});
