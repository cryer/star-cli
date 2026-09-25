import { previewLines } from "../format";
import { toTerminalSafe } from "../terminal-text";

export interface ToolCardData {
  id: string;
  name: string;
  argsSummary: string;
  result?: string;
  isError?: boolean;
}

export function formatToolCard(card: ToolCardData): string {
  const header = `${card.name} ${card.argsSummary}${card.isError ? " [error]" : ""}`;
  if (card.result === undefined) return header;
  const preview = previewLines(toTerminalSafe(card.result), 10);
  return `${header}\n${preview.text}${preview.truncated ? "\n... (truncated)" : ""}`;
}
