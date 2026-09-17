import { ToolRegistry } from "./registry";
import { createTodoTools } from "./todo";

export { ToolRegistry } from "./registry";
export { createTodoTools, TodoStore } from "./todo";
export type { TodoItem } from "./todo";
export type { PermissionLevel, Tool, ToolContext, ToolResult } from "./types";

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createTodoTools()) {
    registry.register(tool);
  }
  return registry;
}
