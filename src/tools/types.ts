import type { z } from "zod";

export type PermissionLevel = "read" | "write" | "exec";

// Who is responsible for a file change, for /undo and /rewind attribution:
// the root loop's changes are undoable per turn; a (background) subagent's
// writes are excluded from turn-level retraction since the subagent's work
// spans arbitrary parent turns.
export interface SnapshotContext {
  owner: "root" | "subagent";
  turn: number;
  messageIndex: number;
}

export interface ToolContext {
  cwd: string;
  abortSignal?: AbortSignal;
  snapshotContext?: SnapshotContext;
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
