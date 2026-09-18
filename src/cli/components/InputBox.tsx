import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

interface InputBoxProps {
  isStreaming: boolean;
  disabled?: boolean;
  onSubmit(text: string): void;
  onInterrupt(): void;
  onExit(): void;
}

export function InputBox({ isStreaming, disabled, onSubmit, onInterrupt, onExit }: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");

  const edit = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
  };

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isStreaming || disabled) {
        onInterrupt();
      } else {
        edit("", 0);
        historyIndexRef.current = null;
      }
      return;
    }
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }
    if (isStreaming || disabled) return;
    if (key.return) {
      const text = value.trim();
      if (text.length > 0) {
        setHistory((prev) => [...prev, text]);
        onSubmit(text);
      }
      edit("", 0);
      historyIndexRef.current = null;
      draftRef.current = "";
      return;
    }
    if (key.upArrow) {
      if (history.length === 0) return;
      if (historyIndexRef.current === null) {
        draftRef.current = value;
        historyIndexRef.current = history.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      const entry = history[historyIndexRef.current] ?? "";
      edit(entry, entry.length);
      return;
    }
    if (key.downArrow) {
      if (historyIndexRef.current === null) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        const entry = history[historyIndexRef.current] ?? "";
        edit(entry, entry.length);
      } else {
        historyIndexRef.current = null;
        edit(draftRef.current, draftRef.current.length);
      }
      return;
    }
    if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor((prev) => Math.min(value.length, prev + 1));
      return;
    }
    if (key.ctrl && input === "a") {
      setCursor(0);
      return;
    }
    if (key.ctrl && input === "e") {
      setCursor(value.length);
      return;
    }
    if (key.ctrl && input === "u") {
      edit(value.slice(cursor), 0);
      return;
    }
    if (key.ctrl && input === "k") {
      edit(value.slice(0, cursor), cursor);
      return;
    }
    if (key.ctrl && input === "w") {
      const trimmed = value.slice(0, cursor).replace(/\s+$/, "");
      const wordStart = trimmed.search(/\S+$/);
      const next = value.slice(0, wordStart === -1 ? 0 : wordStart) + value.slice(cursor);
      edit(next, wordStart === -1 ? 0 : wordStart);
      return;
    }
    // Ink maps both \b and \x7f/Delete-key to backspace/delete; real terminals send
    // \x7f for Backspace, so both act as delete-before-cursor here.
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      edit(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
    }
  });

  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      <Text>{before}</Text>
      <Text inverse>{at}</Text>
      <Text>{after}</Text>
    </Box>
  );
}
