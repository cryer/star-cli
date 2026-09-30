import type { DiffLine } from "../diff-preview";
import { previewLines } from "../format";
import { toolIcon } from "../icons";
import { toTerminalSafe } from "../terminal-text";

export interface ToolCardData {
  id: string;
  name: string;
  argsSummary: string;
  result?: string;
  isError?: boolean;
  // Pre-write diff preview for write_file/edit_file, captured at tool-call
  // time (after execution the file already holds the new content, so an
  // overwrite would diff empty). Rendered under the card.
  diff?: DiffLine[];
}

export function formatToolCard(card: ToolCardData): string {
  const header = `${toolIcon(card.name)} ${card.name} ${card.argsSummary}${card.isError ? " [error]" : ""}`;
  if (card.result === undefined) return header;
  const preview = previewLines(toTerminalSafe(card.result), 10);
  return `${header}\n${preview.text}${preview.truncated ? "\n... (truncated)" : ""}`;
}
