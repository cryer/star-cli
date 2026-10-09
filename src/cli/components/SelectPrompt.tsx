import { Box, Text } from "ink";
import { useRef, useState } from "react";
import { useInput } from "../use-input";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  hint?: string;
}

interface SelectPromptProps {
  title: string;
  options: SelectOption[];
  onSelect(value: string): void;
  onCancel(): void;
  // Enables [Ctrl+X] deletion of the highlighted option (used by the /resume
  // session picker). Must return the options remaining after the deletion;
  // the highlight clamps to the new list. An empty list means the caller
  // closed the picker.
  onDelete?(value: string): Promise<SelectOption[]>;
}

export const SELECT_PROMPT_MAX_VISIBLE = 9;

export function SelectPrompt({ title, options, onSelect, onCancel, onDelete }: SelectPromptProps) {
  const [index, setIndex] = useState(0);
  const indexRef = useRef(0);
  const [confirming, setConfirming] = useState<SelectOption | null>(null);
  const confirmingRef = useRef<SelectOption | null>(null);
  const deletingRef = useRef(false);
  const setConfirm = (option: SelectOption | null) => {
    confirmingRef.current = option;
    setConfirming(option);
  };
  const move = (delta: number) => {
    indexRef.current = Math.max(0, Math.min(indexRef.current + delta, options.length - 1));
    setIndex(indexRef.current);
  };

  useInput((input, key) => {
    const pending = confirmingRef.current;
    if (pending) {
      if (input === "y" || input === "Y") {
        setConfirm(null);
        if (onDelete && !deletingRef.current) {
          deletingRef.current = true;
          void onDelete(pending.value)
            .catch(() => options)
            .then((next) => {
              deletingRef.current = false;
              indexRef.current = Math.min(indexRef.current, Math.max(0, next.length - 1));
              setIndex(indexRef.current);
            });
        }
      } else if (input === "n" || input === "N" || key.escape) {
        setConfirm(null);
      }
      return;
    }
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const option = options[indexRef.current];
      if (option) onSelect(option.value);
      return;
    }
    if (onDelete && key.ctrl && input === "x") {
      const option = options[indexRef.current];
      if (option) setConfirm(option);
      return;
    }
    if (key.downArrow || input === "j") {
      move(1);
    } else if (key.upArrow || input === "k") {
      move(-1);
    }
  });

  const maxStart = Math.max(0, options.length - SELECT_PROMPT_MAX_VISIBLE);
  const start = Math.min(Math.max(0, index - Math.floor(SELECT_PROMPT_MAX_VISIBLE / 2)), maxStart);
  const visible = options.slice(start, start + SELECT_PROMPT_MAX_VISIBLE);
  const above = start;
  const below = options.length - start - visible.length;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {above > 0 && <Text dimColor>… {above} more above</Text>}
      {visible.map((option, i) => {
        const active = start + i === index;
        return (
          <Text key={option.value}>
            <Text bold={active} inverse={active}>
              {active ? "❯ " : "  "}
              {option.label}
            </Text>
            {option.hint && <Text dimColor> ({option.hint})</Text>}
            {option.description && <Text dimColor> — {option.description}</Text>}
          </Text>
        );
      })}
      {below > 0 && <Text dimColor>… {below} more below</Text>}
      {confirming ? (
        <Text color="red">Delete {confirming.label}? [y] yes [n] no</Text>
      ) : (
        <Text dimColor>
          [↑/↓ or j/k] move [Enter] select{onDelete ? " [Ctrl+X] delete" : ""} [Esc] cancel
        </Text>
      )}
    </Box>
  );
}
