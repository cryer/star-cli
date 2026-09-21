import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../permissions/types";
import type { DiffPreview } from "../diff-preview";
import { summarizeArgs } from "../format";
import { DiffLines } from "./DiffLines";

export type PermissionDecision = "yes" | "no" | "always";

interface PermissionPromptProps {
  request: PermissionRequest;
  preview?: DiffPreview | null;
  onDecision(decision: PermissionDecision): void;
}

export function PermissionPrompt({ request, preview, onDecision }: PermissionPromptProps) {
  useInput((input) => {
    const ch = input.toLowerCase();
    if (ch === "y") onDecision("yes");
    else if (ch === "n") onDecision("no");
    else if (ch === "a") onDecision("always");
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Permission required: {request.toolName} ({request.level})
      </Text>
      {preview ? (
        <Box flexDirection="column">
          <Text dimColor>
            {preview.type === "new-file" ? "New file: " : ""}
            {preview.label}
          </Text>
          <DiffLines lines={preview.lines} />
        </Box>
      ) : (
        <Text>{summarizeArgs(request.args)}</Text>
      )}
      <Text>[y] allow [n] deny [a] always (saved to config)</Text>
    </Box>
  );
}
