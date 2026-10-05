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
  // Identity of the agent loop running the tool: "root" for the main loop, a
  // unique id per subagent loop (its background task id when spawned with
  // run_in_background, a throwaway id otherwise). Background tasks record it
  // as their owner so task_list/task_output/task_kill can scope a subagent
  // to its own tasks while root reaches all. Undefined means root.
  agentId?: string;
  // False when the active model is text-only ([[models]] vision = false):
  // image-producing tools (read_image, screenshot) must decline with a text
  // error rather than attach images the endpoint would reject. Undefined
  // means images are allowed.
  visionEnabled?: boolean;
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
