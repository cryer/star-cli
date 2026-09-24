import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

interface TextFieldProps {
  label: string;
  initialValue?: string;
  // echoes bullets instead of the raw text (API keys)
  masked?: boolean;
  placeholder?: string;
  onSubmit(value: string): void;
  onCancel(): void;
}

const MASK_CAP = 24;

// Minimal single-line text input for wizard-style prompts; Enter submits the
// trimmed value, Backspace deletes, Esc cancels.
export function TextField({
  label,
  initialValue = "",
  masked = false,
  placeholder,
  onSubmit,
  onCancel,
}: TextFieldProps) {
  const [value, setValue] = useState(initialValue);
  const valueRef = useRef(initialValue);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSubmit(valueRef.current.trim());
      return;
    }
    if (key.backspace || key.delete) {
      valueRef.current = valueRef.current.slice(0, -1);
      setValue(valueRef.current);
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    valueRef.current += input;
    setValue(valueRef.current);
  });

  const echo = masked ? "•".repeat(Math.min(value.length, MASK_CAP)) : value;
  return (
    <Box flexDirection="column">
      <Text>
        {label} <Text bold>{echo}</Text>
        {value === "" && placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Text>
      <Text dimColor>[Enter] confirm [Esc] cancel</Text>
    </Box>
  );
}
