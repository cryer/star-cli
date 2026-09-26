import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../permissions/types";
import type { DiffPreview } from "../diff-preview";
import { summarizeArgs } from "../format";
import { toTerminalSafe } from "../terminal-text";
import { DiffLines } from "./DiffLines";

export type PermissionDecision = "yes" | "no" | "always";

interface PermissionPromptProps {
  request: PermissionRequest;
  preview?: DiffPreview | null;
  onDecision(decision: PermissionDecision): void;
}

// Bash commands render in full and wrap: a tail-truncated command would let a
// malicious payload hide past the visible cutoff. Only absurdly long commands
// are middle-truncated, keeping both ends in view.
const BASH_COMMAND_MAX = 1000;

function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

function bashCommand(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

export function PermissionPrompt({ request, preview, onDecision }: PermissionPromptProps) {
  useInput((input) => {
    const ch = input.toLowerCase();
    if (ch === "y") onDecision("yes");
    else if (ch === "n") onDecision("no");
    else if (ch === "a") onDecision("always");
  });

  const command = request.toolName === "bash" ? bashCommand(request.args) : null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required: {request.toolName} ({request.level})
      </Text>
      {preview ? (
        <Box flexDirection="column">
          <Text dimColor>
            {preview.type === "new-file" ? "New file: " : ""}
            {toTerminalSafe(preview.label)}
          </Text>
          <DiffLines lines={preview.lines} />
        </Box>
      ) : command !== null ? (
        <Text>{toTerminalSafe(middleTruncate(command, BASH_COMMAND_MAX))}</Text>
      ) : (
        <Text>{toTerminalSafe(summarizeArgs(request.args))}</Text>
      )}
      <Text>[y] allow [n] deny [a] always (saved to config)</Text>
    </Box>
  );
}
