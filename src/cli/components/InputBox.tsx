import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";

interface InputBoxProps {
  isStreaming: boolean;
  onSubmit(text: string): void;
  onInterrupt(): void;
  onExit(): void;
}

export function InputBox({ isStreaming, onSubmit, onInterrupt, onExit }: InputBoxProps) {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (isStreaming) {
        onInterrupt();
      } else {
        setValue("");
        historyIndexRef.current = null;
      }
      return;
    }
    if (key.ctrl && input === "d") {
      onExit();
      return;
    }
    if (isStreaming) return;
    if (key.return) {
      const text = value.trim();
      if (text.length > 0) {
        setHistory((prev) => [...prev, text]);
        onSubmit(text);
      }
      setValue("");
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
      setValue(history[historyIndexRef.current] ?? "");
      return;
    }
    if (key.downArrow) {
      if (historyIndexRef.current === null) return;
      if (historyIndexRef.current < history.length - 1) {
        historyIndexRef.current += 1;
        setValue(history[historyIndexRef.current] ?? "");
      } else {
        historyIndexRef.current = null;
        setValue(draftRef.current);
      }
      return;
    }
    if (key.backspace || key.delete) {
      setValue((prev) => prev.slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setValue((prev) => prev + input);
    }
  });

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">{"> "}</Text>
      <Text>{value}</Text>
    </Box>
  );
}
