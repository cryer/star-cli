import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { type BracketPasteState, feedBracketedPaste } from "./InputBox";

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
  const bracketRef = useRef<BracketPasteState>({ active: false, buffer: "", pending: "" });

  // A paste whose end marker never arrived keeps its content buffered; fold it
  // into the value before any key acts on it (mirrors InputBox's flush).
  const flushBracket = () => {
    const bracket = bracketRef.current;
    const content = bracket.buffer.replace(/[\r\n]+/g, "");
    bracket.active = false;
    bracket.buffer = "";
    bracket.pending = "";
    if (content.length > 0) {
      valueRef.current += content;
      setValue(valueRef.current);
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      flushBracket();
      onSubmit(valueRef.current.trim());
      return;
    }
    if (key.backspace || key.delete) {
      flushBracket();
      valueRef.current = valueRef.current.slice(0, -1);
      setValue(valueRef.current);
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    // Pasted text arrives wrapped in bracketed-paste markers (InputBox enables
    // the mode terminal-wide); feed through the shared state machine so the
    // markers never land in the value and the field stays editable. Null means
    // the event carried only (partial) markers — nothing to append.
    const segments = feedBracketedPaste(bracketRef.current, input);
    if (segments === null) return;
    const text = segments
      .map((segment) => segment.text)
      .join("")
      .replace(/[\r\n]+/g, "");
    if (text.length === 0) return;
    valueRef.current += text;
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
