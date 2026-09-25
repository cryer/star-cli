import { Box, Text } from "ink";
import type { TodoItem } from "../../tools/todo";
import { toTerminalSafe } from "../terminal-text";

const SYMBOLS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

// The panel lives in Ink's live region, so its height must stay bounded:
// an unbounded list can reach terminal height, at which point Ink repaints
// the entire static history on every frame (the "scroll spam" bug).
export const MAX_VISIBLE_TODOS = 10;

export interface TodoWindow {
  items: TodoItem[];
  hiddenBefore: number;
  hiddenAfter: number;
}

// Window of at most `max` items. When the list overflows, the window starts
// at the in-progress item (or the list head) so the active task and what
// comes next stay visible.
export function visibleTodoWindow(
  todos: readonly TodoItem[],
  max: number = MAX_VISIBLE_TODOS,
): TodoWindow {
  if (todos.length <= max) return { items: [...todos], hiddenBefore: 0, hiddenAfter: 0 };
  const active = todos.findIndex((todo) => todo.status === "in_progress");
  const start = active > 0 ? Math.min(active, todos.length - max) : 0;
  const items = todos.slice(start, start + max);
  return {
    items,
    hiddenBefore: start,
    hiddenAfter: todos.length - start - items.length,
  };
}

// Persistent todo list rendered in the live region above the input box, so
// it survives spinner/thinking redraws; finished items are dimmed.
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  const { items, hiddenBefore, hiddenAfter } = visibleTodoWindow(todos);
  return (
    <Box flexDirection="column">
      {hiddenBefore > 0 && <Text dimColor> … {hiddenBefore} more above</Text>}
      {items.map((todo) => (
        <Text
          key={todo.id}
          dimColor={todo.status === "done"}
          color={todo.status === "in_progress" ? "cyan" : undefined}
        >
          {SYMBOLS[todo.status]} {toTerminalSafe(todo.title)}
        </Text>
      ))}
      {hiddenAfter > 0 && <Text dimColor> … {hiddenAfter} more</Text>}
    </Box>
  );
}
