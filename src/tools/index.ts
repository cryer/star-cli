import { ToolRegistry } from "./registry";

export { ToolRegistry } from "./registry";
export type { PermissionLevel, Tool, ToolContext, ToolResult } from "./types";

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry();
}
