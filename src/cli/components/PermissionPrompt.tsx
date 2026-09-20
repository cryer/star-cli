import { Box, Text, useInput } from "ink";
import type { PermissionRequest } from "../../permissions/types";
import type { DiffLine, DiffPreview } from "../diff-preview";
import { summarizeArgs } from "../format";

export type PermissionDecision = "yes" | "no" | "always";

interface PermissionPromptProps {
  request: PermissionRequest;
  preview?: DiffPreview | null;
  onDecision(decision: PermissionDecision): void;
}

function DiffLineView({ line }: { line: DiffLine }) {
  if (line.kind === "add") return <Text color="green">+ {line.text}</Text>;
  if (line.kind === "del") return <Text color="red">- {line.text}</Text>;
  if (line.kind === "marker") return <Text dimColor>{line.text}</Text>;
  return <Text dimColor> {line.text}</Text>;
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
          {preview.lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable identity
            <DiffLineView key={index} line={line} />
          ))}
        </Box>
      ) : (
        <Text>{summarizeArgs(request.args)}</Text>
      )}
      <Text>[y] allow [n] deny [a] always (saved to config)</Text>
    </Box>
  );
}
