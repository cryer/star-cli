import type { z } from "zod";

export type PermissionLevel = "read" | "write" | "exec";

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  permission: PermissionLevel;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}
