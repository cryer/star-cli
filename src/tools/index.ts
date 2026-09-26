import { ToolRegistry } from "./registry";
import type { TodoStore } from "./todo";

export { ToolRegistry } from "./registry";
export { TodoStore, createTodoTools, setTodoPersistGuard } from "./todo";
export type { TodoItem } from "./todo";
export type { PermissionLevel, Tool, ToolContext, ToolResult } from "./types";

// The registry constructor registers every built-in tool (todo tools
// included); this helper only forwards the optional per-loop todo store.
export function createDefaultRegistry(todoStore?: TodoStore): ToolRegistry {
  return new ToolRegistry(todoStore);
}
