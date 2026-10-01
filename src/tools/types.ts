import type { z } from "zod";
import type { ImageInput } from "../core/messages";

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
  // Image attachments the model must actually see (read_image, screenshot). The agent
  // loop appends them to the history as a user message with image parts —
  // tool results themselves are text-only on every protocol.
  images?: ImageInput[];
}

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  parameters: S;
  permission: PermissionLevel;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
  // Clears per-session volatile state (e.g. read_file's unchanged-since-last-
  // read cache). The agent loop calls this whenever the history is rewritten
  // wholesale (compaction, /undo, resume): content the cache claims is "still
  // in context" may no longer be.
  reset?(): void;
}
