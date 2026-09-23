import { Box, Text } from "ink";
import type { TodoItem } from "../../tools/todo";

const SYMBOLS: Record<TodoItem["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
};

// Persistent todo list rendered in the live region above the input box, so
// it survives spinner/thinking redraws; finished items are dimmed.
export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  if (todos.length === 0) return null;
  return (
    <Box flexDirection="column">
      {todos.map((todo) => (
        <Text
          key={todo.id}
          dimColor={todo.status === "done"}
          color={todo.status === "in_progress" ? "cyan" : undefined}
        >
          {SYMBOLS[todo.status]} {todo.title}
        </Text>
      ))}
    </Box>
  );
}
