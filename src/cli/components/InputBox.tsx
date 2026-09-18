import { Box, Text, useInput } from "ink";
import { useRef, useState } from "react";
import { type SlashCommandHint, filterCommands } from "../commands/suggest";

interface InputBoxProps {
  isStreaming: boolean;
  disabled?: boolean;
  commands?: SlashCommandHint[];
  onSubmit(text: string): void;
  onInterrupt(): void;
  onExit(): void;
}

export function InputBox({
  isStreaming,
  disabled,
  commands,
  onSubmit,
  onInterrupt,
  onExit,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");

  const edit = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setHighlight(0);
    setSuggestionsDismissed(false);
  };

  const suggestions =
    isStreaming || disabled || suggestionsDismissed || !commands
      ? []
      : filterCommands(value, commands);
  const activeIndex = suggestions.length === 0 ? 0 : Math.min(highlight, suggestions.length - 1);

  const completeHighlighted = () => {
    const cmd = suggestions[activeIndex];
    if (!cmd) return;
    const text = `/${cmd.name} `;
    edit(text, text.length);
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
    if (key.escape) {
      if (suggestions.length > 0) setSuggestionsDismissed(true);
      return;
    }
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
    if (key.tab) {
      if (suggestions.length > 0) {
        completeHighlighted();
        return;
      }
    } else if (key.upArrow) {
      if (suggestions.length > 0) {
        setHighlight((prev) => (prev - 1 + suggestions.length) % suggestions.length);
        return;
      }
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
    } else if (key.downArrow) {
      if (suggestions.length > 0) {
        setHighlight((prev) => (prev + 1) % suggestions.length);
        return;
      }
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
    } else if (key.leftArrow) {
      setCursor((prev) => Math.max(0, prev - 1));
      return;
    } else if (key.rightArrow) {
      if (suggestions.length > 0 && cursor === value.length) {
        completeHighlighted();
      } else {
        setCursor((prev) => Math.min(value.length, prev + 1));
      }
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
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color="cyan">{"> "}</Text>
        <Text>{before}</Text>
        <Text inverse>{at}</Text>
        <Text>{after}</Text>
      </Box>
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((cmd, index) =>
            index === activeIndex ? (
              <Text key={cmd.name} bold inverse>{`/${cmd.name} - ${cmd.description}`}</Text>
            ) : (
              <Text key={cmd.name}>
                <Text color="cyan">{`/${cmd.name}`}</Text>
                <Text dimColor>{` - ${cmd.description}`}</Text>
              </Text>
            ),
          )}
        </Box>
      )}
    </Box>
  );
}
