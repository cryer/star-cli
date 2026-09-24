import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import { type SlashCommandHint, filterCommands } from "../commands/suggest";
import { type PathSuggestion, extractAtToken, suggestPaths } from "../path-suggest";

export interface InputRefill {
  text: string;
  seq: number;
}

// Cursor position one visual line up/down (lines split on \n), keeping the
// column clamped to the target line's length. Null when there is no line in
// that direction.
export function moveCursorLines(value: string, cursor: number, delta: -1 | 1): number | null {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  const col = cursor - lineStart;
  if (delta === -1) {
    if (lineStart === 0) return null;
    const prevEnd = lineStart - 1;
    const prevStart = value.lastIndexOf("\n", prevEnd - 1) + 1;
    return prevStart + Math.min(col, prevEnd - prevStart);
  }
  const lineEndIndex = value.indexOf("\n", cursor);
  if (lineEndIndex === -1) return null;
  const nextStart = lineEndIndex + 1;
  const nextEndIndex = value.indexOf("\n", nextStart);
  const nextEnd = nextEndIndex === -1 ? value.length : nextEndIndex;
  return nextStart + Math.min(col, nextEnd - nextStart);
}

// Case-insensitive substring scan for reverse history search: step -1 walks
// from `from` toward older entries, step 1 toward newer ones. Null on no match.
export function findHistoryMatch(
  history: string[],
  query: string,
  from: number,
  step: -1 | 1,
): number | null {
  const needle = query.toLowerCase();
  for (let i = from; i >= 0 && i < history.length; i += step) {
    if ((history[i] ?? "").toLowerCase().includes(needle)) return i;
  }
  return null;
}

interface ReverseSearch {
  query: string;
  // Index into history of the currently shown match; null when nothing matches.
  match: number | null;
}

interface InputBoxProps {
  isStreaming: boolean;
  disabled?: boolean;
  commands?: SlashCommandHint[];
  cwd?: string;
  // Refill request (double-Esc edit): when seq changes, the input is replaced.
  refill?: InputRefill;
  // History entries loaded from disk; used only as the initial history state.
  initialHistory?: string[];
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
  initialHistory,
  onSubmit,
  onInterrupt,
  onExit,
  onPasteImage,
}: InputBoxProps) {
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [history, setHistory] = useState<string[]>(() => initialHistory ?? []);
  const [highlight, setHighlight] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);
  const [pathSuggestions, setPathSuggestions] = useState<PathSuggestion[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const draftRef = useRef("");
  const refillSeqRef = useRef(0);
  const [search, setSearch] = useState<ReverseSearch | null>(null);
  const searchSavedRef = useRef<{ value: string; cursor: number } | null>(null);

  const edit = (next: string, nextCursor: number) => {
    // Editing a recalled history entry (or typing anything else) ends the
    // pristine history-browsing state, so up/down go back to moving the
    // cursor between lines instead of switching entries.
    const idx = historyIndexRef.current;
    if (idx !== null && next !== history[idx]) historyIndexRef.current = null;
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

  const suggestionsEnabled = !isStreaming && !disabled && !suggestionsDismissed && !search;
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
    // Ctrl+R: bash-style reverse history search. Entering remembers the
    // current input so cancel (Esc/Ctrl+C/Ctrl+G) can restore it.
    if (key.ctrl && input === "r") {
      if (isStreaming || disabled) return;
      if (search) {
        // Already searching: jump to the next older match (stops at the end).
        const from = (search.match ?? history.length) - 1;
        const older = findHistoryMatch(history, search.query, from, -1);
        if (older !== null) setSearch({ ...search, match: older });
      } else {
        searchSavedRef.current = { value, cursor };
        setSearch({ query: "", match: history.length > 0 ? history.length - 1 : null });
      }
      return;
    }
    if (search) {
      const exitSearch = (accept: boolean) => {
        const saved = searchSavedRef.current;
        setSearch(null);
        searchSavedRef.current = null;
        const match = accept && search.match !== null ? history[search.match] : undefined;
        if (match !== undefined) {
          edit(match, match.length);
        } else if (saved) {
          edit(saved.value, saved.cursor);
        }
      };
      if (key.escape || (key.ctrl && (input === "c" || input === "g"))) {
        exitSearch(false);
        return;
      }
      if (key.return) {
        exitSearch(true);
        return;
      }
      // A query change always re-searches from the newest entry backwards.
      const requery = (query: string) =>
        setSearch({ query, match: findHistoryMatch(history, query, history.length - 1, -1) });
      if (key.backspace || key.delete) {
        requery(search.query.slice(0, -1));
        return;
      }
      if (key.upArrow) {
        const from = (search.match ?? history.length) - 1;
        const older = findHistoryMatch(history, search.query, from, -1);
        if (older !== null) setSearch({ ...search, match: older });
        return;
      }
      if (key.downArrow) {
        if (search.match !== null) {
          const newer = findHistoryMatch(history, search.query, search.match + 1, 1);
          if (newer !== null) setSearch({ ...search, match: newer });
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        requery(search.query + text);
      }
      // Every other key (Tab, arrows, ctrl editing keys, ...) is ignored.
      return;
    }
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
      // Backslash immediately before the cursor + Enter: universal manual
      // newline (works on every terminal, Claude-Code style).
      if (value[cursor - 1] === "\\") {
        edit(`${value.slice(0, cursor - 1)}\n${value.slice(cursor)}`, cursor);
        return;
      }
      const text = value.trim();
      if (text.length > 0) {
        // Slash commands are ephemeral; keep them out of the history.
        if (!text.startsWith("/")) setHistory((prev) => [...prev, text]);
        onSubmit(text);
      }
      edit("", 0);
      historyIndexRef.current = null;
      draftRef.current = "";
      return;
    }
    // Ctrl+J arrives as a raw \n and Alt+Enter as ESC+CR (Ink strips the ESC).
    if (input === "\n" || input === "\r") {
      edit(`${value.slice(0, cursor)}\n${value.slice(cursor)}`, cursor + 1);
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
      // Pristine history browsing beats suggestion cycling: a recalled
      // slash command activates the suggestion menu and would otherwise
      // trap the arrows in it.
      if (historyIndexRef.current !== null) {
        if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
          const entry = history[historyIndexRef.current] ?? "";
          edit(entry, entry.length);
        }
        return;
      }
      if (suggestionCount > 0) {
        setHighlight((prev) => (prev - 1 + suggestionCount) % suggestionCount);
        return;
      }
      // Own (or edited) text: move the cursor between lines first.
      const moved = moveCursorLines(value, cursor, -1);
      if (moved !== null) {
        setCursor(moved);
        return;
      }
      if (history.length === 0) return;
      draftRef.current = value;
      historyIndexRef.current = history.length - 1;
      const entry = history[historyIndexRef.current] ?? "";
      edit(entry, entry.length);
      return;
    } else if (key.downArrow) {
      if (historyIndexRef.current !== null) {
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
      if (suggestionCount > 0) {
        setHighlight((prev) => (prev + 1) % suggestionCount);
        return;
      }
      const moved = moveCursorLines(value, cursor, 1);
      if (moved !== null) setCursor(moved);
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
      // Pasted text may carry CRLF line endings; normalize so the value only
      // ever holds \n and rendering stays consistent.
      const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
    }
  });

  const before = value.slice(0, cursor);
  const at = value[cursor];
  const after = value.slice(cursor + 1);
  // A newline under the cursor is shown as an inverse space at the line end,
  // with the newline itself rendered after it.
  const cursorChar = at === "\n" || at === undefined ? " " : at;
  const tail = (at === "\n" ? "\n" : "") + after;

  // One pre-styled string in a single Text node. Sibling Text nodes wrap
  // independently (stranding the cursor on its own line on soft-wrap), and
  // inserting/removing children inside ink-text skips Yoga's dirty marking
  // (ink's insertBeforeNode early-return), leaving the node measured at a
  // stale width so text spills over the border. A lone string child only
  // ever updates nodeValue, which always re-measures.
  const styled = search
    ? `\u001B[36m(reverse-search) \u001B[39m'${search.query}': ${
        search.match === null
          ? "\u001B[2mno match\u001B[22m\u001B[7m \u001B[27m"
          : `${history[search.match]}\u001B[7m \u001B[27m`
      }`
    : `\u001B[36m> \u001B[39m${before}\u001B[7m${cursorChar}\u001B[27m${tail}`;

  return (
    <Box flexDirection="column">
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text>{styled}</Text>
      </Box>
      {suggestions.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {suggestions.map((cmd, index) => {
            const label = cmd.usage ?? `/${cmd.name}`;
            return index === activeIndex ? (
              <Text key={cmd.name} bold inverse>{`${label} - ${cmd.description}`}</Text>
            ) : (
              <Text key={cmd.name}>
                <Text color="cyan">{label}</Text>
                <Text dimColor>{` - ${cmd.description}`}</Text>
              </Text>
            );
          })}
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
