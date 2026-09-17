import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../permissions/types";
import { summarizeArgs } from "../format";

export type PermissionDecision = "yes" | "no" | "always";

interface PermissionPromptProps {
  request: PermissionRequest;
  onDecision(decision: PermissionDecision): void;
}

export function PermissionPrompt({ request, onDecision }: PermissionPromptProps) {
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
      <Text>{summarizeArgs(request.args)}</Text>
      <Text>[y] allow [n] deny [a] always</Text>
    </Box>
  );
}
