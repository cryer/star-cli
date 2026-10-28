import { Box, Text } from "ink";
import { memo } from "react";
import { cellWidth } from "../markdown";

export function streamingTail(text: string, maxLines: number, columns: number): string {
  if (maxLines <= 0) return "";
  const width = Math.max(2, columns);
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const ch of text) {
    if (ch === "\n") {
      lines.push(line);
      line = "";
      lineWidth = 0;
      continue;
    }
    const charWidth = cellWidth(ch);
    if (line && lineWidth + charWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += ch;
    lineWidth += charWidth;
  }
  lines.push(line);
  return lines.slice(-maxLines).join("\n");
}

export const StreamingMessage = memo(function StreamingMessage({
  text,
  continuation,
  maxLines = 20,
  columns = 80,
}: {
  text: string;
  continuation?: boolean;
  maxLines?: number;
  columns?: number;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {!continuation && (
        <Text bold color="green">
          ✦ star
        </Text>
      )}
      <Text color="green">{streamingTail(text, maxLines, columns)}</Text>
    </Box>
  );
});
