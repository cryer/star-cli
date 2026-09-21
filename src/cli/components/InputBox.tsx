import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { type SlashCommandHint, filterCommands } from "../commands/suggest";
import { type PathSuggestion, extractAtToken, suggestPaths } from "../path-suggest";

export interface InputRefill {
  text: string;
  seq: number;
}

interface InputBoxProps {
  isStreaming: boolean;
  disabled?: boolean;
  commands?: SlashCommandHint[];
  cwd?: string;
  // Refill request (double-Esc edit): when seq changes, the input is replaced.
  refill?: InputRefill;
  onSubmit(text: string): void;
  onInterrupt(): void;
  onExit(): void;
  // Async clipboard-image read (Alt+V / Ctrl+V); staging is the parent's job.
  onPasteImage?(): void;
}

export function InputBox({
  isStreaming,
  disabled,
  commands,
  cwd,
  refill,
  onSubmit,
  onInterrupt,
  onExit,
  onPasteImage,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState<PathSuggestion[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const refillSeqRef = useRef(0);

  const edit = (next: string, nextCursor: number) => {
    setValue(next);
    setCursor(Math.max(0, Math.min(nextCursor, next.length)));
    setHighlight(0);
    setSuggestionsDismissed(false);
  };

  useEffect(() => {
    if (refill && refill.seq !== refillSeqRef.current) {
      refillSeqRef.current = refill.seq;
      edit(refill.text, refill.text.length);
    }
  });

  const suggestionsEnabled = !isStreaming && !disabled && !suggestionsDismissed;
  const suggestions = suggestionsEnabled && commands ? filterCommands(value, commands) : [];

  useEffect(() => {
    if (!suggestionsEnabled || !cwd) {
      setPathSuggestions([]);
      return;
    }
    const token = extractAtToken(value, cursor);
    if (!token) {
      setPathSuggestions([]);
      return;
    }
    let cancelled = false;
    void suggestPaths(token.token, cwd).then((result) => {
      if (!cancelled) setPathSuggestions(result);
    });
    return () => {
      cancelled = true;
    };
  }, [value, cursor, cwd, suggestionsEnabled]);

  const showPathSuggestions = suggestions.length === 0 && pathSuggestions.length > 0;
  const suggestionCount = suggestions.length > 0 ? suggestions.length : pathSuggestions.length;
  const activeIndex = suggestionCount === 0 ? 0 : Math.min(highlight, suggestionCount - 1);

  const completeHighlighted = () => {
    if (suggestions.length > 0) {
      const cmd = suggestions[activeIndex];
      if (!cmd) return;
      const text = `/${cmd.name} `;
      edit(text, text.length);
      return;
    }
    const sugg = pathSuggestions[activeIndex];
    const token = extractAtToken(value, cursor);
    if (!sugg || !token) return;
    const replacement = `@${sugg.path}${sugg.isDir ? "" : " "}`;
    edit(
      value.slice(0, token.start) + replacement + value.slice(token.end),
      token.start + replacement.length,
    );
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
    // Alt+V is the reliable binding: Windows Terminal (and cmd's conhost)
    // intercept Ctrl+V as their own paste, so the key never reaches us.
    if ((key.meta || key.ctrl) && input === "v") {
      onPasteImage?.();
      return;
    }
    if (disabled) return;
    if (key.escape) {
      // While streaming, Esc is the Repl-level interrupt; idle Esc only
      // dismisses suggestions here (double-Esc editing lives in the Repl).
      if (!isStreaming && suggestionCount > 0) setSuggestionsDismissed(true);
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
      // Shift+Tab cycles permission modes at the Repl level; never complete.
      if (key.shift) return;
      if (suggestionCount > 0) {
        completeHighlighted();
        return;
      }
    } else if (key.upArrow) {
      if (suggestionCount > 0) {
        setHighlight((prev) => (prev - 1 + suggestionCount) % suggestionCount);
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
      if (suggestionCount > 0) {
        setHighlight((prev) => (prev + 1) % suggestionCount);
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
      if (suggestionCount > 0 && cursor === value.length) {
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
      {showPathSuggestions && (
        <Box flexDirection="column" paddingLeft={2}>
          {pathSuggestions.map((sugg, index) =>
            index === activeIndex ? (
              <Text key={sugg.path} bold inverse>{`@${sugg.path}`}</Text>
            ) : (
              <Text key={sugg.path}>
                <Text color="cyan">{`@${sugg.path}`}</Text>
                {sugg.isDir && <Text dimColor> - directory</Text>}
              </Text>
            ),
          )}
        </Box>
      )}
    </Box>
  );
}
