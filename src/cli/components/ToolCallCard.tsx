import { Box, Text } from "ink";
import { memo } from "react";
import { previewLines } from "../format";

export interface ToolCardData {
  id: string;
  name: string;
  argsSummary: string;
  result?: string;
  isError?: boolean;
}

export const ToolCallCard = memo(function ToolCallCard({ card }: { card: ToolCardData }) {
  const color = card.isError ? "red" : "magenta";
  const preview = card.result !== undefined ? previewLines(card.result, 10) : null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={color}>
        tool: {card.name}
        {card.isError ? " (error)" : ""}
      </Text>
      <Text dimColor>{card.argsSummary}</Text>
      {preview && (
        <Text color={color}>
          {preview.text}
          {preview.truncated ? "\n... (truncated)" : ""}
        </Text>
      )}
    </Box>
  );
});

export function formatToolCard(card: ToolCardData): string {
  const header = `${card.name} ${card.argsSummary}${card.isError ? " [error]" : ""}`;
  if (card.result === undefined) return header;
  const preview = previewLines(card.result, 10);
  return `${header}\n${preview.text}${preview.truncated ? "\n... (truncated)" : ""}`;
}
