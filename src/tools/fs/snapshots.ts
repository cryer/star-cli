import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SnapshotContext } from "../types";

export type SnapshotOwner = "root" | "subagent";

export interface FileSnapshot {
  // Checkpoint id, monotonically increasing per process (seeded from the
  // resumed session's records, so ids stay unique across resume). Assigned
  // when the snapshot is captured; failed tool calls leave gaps, which is fine.
  id: number;
  path: string;
  existed: boolean;
  content: string | null;
  // Set when the pre-change content exceeded MAX_SNAPSHOT_CONTENT_BYTES: only
  // metadata is kept (no content, no persisted content file) and revert()
  // skips the file instead of restoring it.
  contentTooLarge?: boolean;
  // Lazy source for the old content when the snapshot was hydrated from a
  // persisted session checkpoint instead of captured in this process.
  contentFile?: string;
  toolName: string;
  timestamp: number;
  // Seq of the conversation turn that produced this snapshot (0 = no turn
  // context, e.g. direct tool use in tests). Monotonically increasing per
  // process, so a turn's snapshots can be reverted without touching older ones.
  turn: number;
  // Index of the user message that started the turn, used by /rewind to
  // retract the conversation to the same point. -1 = unknown (no turn
  // context, or the change came from a subagent turn).
  messageIndex: number;
  // Who made the change. Root changes are undoable per turn; subagent changes
  // span arbitrary parent turns, so turn-scoped listings and reverts exclude
  // them unless includeSubagent is passed. Missing means root (checkpoints
  // persisted before this field stay undoable).
  owner?: SnapshotOwner;
}

// Persistence callbacks, bound by the agent loop when a session store is
// attached. Every snapshot that enters or leaves the in-memory stack is
// mirrored to the session directory so /rewind works after resume.
export interface SnapshotHooks {
  onPush?(snapshot: FileSnapshot): void | Promise<void>;
  onRemove?(ids: number[]): void | Promise<void>;
}

const MAX_SNAPSHOTS = 50;
export const MAX_SNAPSHOT_CONTENT_BYTES = 5 * 1024 * 1024;

const stack: FileSnapshot[] = [];
let activeTurn = 0;
let activeTurnMessageIndex = -1;
let checkpointSeq = 0;
let hooks: SnapshotHooks | null = null;

export function setSnapshotHooks(next: SnapshotHooks | null): void {
  hooks = next;
}

export function nextSnapshotId(): number {
  return ++checkpointSeq;
}

// Called by the agent loop at the start of every conversation turn; returns
// the seq assigned to the turn. Tool-made snapshots record this seq and the
// message index the turn started at.
export function beginTurn(messageIndex = -1): number {
  activeTurnMessageIndex = messageIndex;
  return ++activeTurn;
}

export function currentTurnSeq(): number {
  return activeTurn;
}

export function currentTurnMessageIndex(): number {
  return activeTurnMessageIndex;
}

function ownerOf(snapshot: FileSnapshot): SnapshotOwner {
  return snapshot.owner ?? "root";
}

export async function captureSnapshot(
  filePath: string,
  toolName: string,
  snapshotContext?: SnapshotContext,
): Promise<FileSnapshot> {
  let content: string | null = null;
  let existed = false;
  let contentTooLarge = false;
  const st = await stat(filePath).catch(() => null);
  if (st?.isFile()) {
    existed = true;
    if (st.size > MAX_SNAPSHOT_CONTENT_BYTES) {
      contentTooLarge = true;
    } else {
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        // unreadable files keep the old behavior: recorded as non-existent
        existed = false;
      }
    }
  }
  return {
    id: nextSnapshotId(),
    path: filePath,
    existed,
    content,
    contentTooLarge: contentTooLarge || undefined,
    toolName,
    timestamp: Date.now(),
    turn: snapshotContext?.turn ?? activeTurn,
    messageIndex: snapshotContext?.messageIndex ?? activeTurnMessageIndex,
    owner: snapshotContext?.owner ?? "root",
  };
}

export async function pushSnapshot(snapshot: FileSnapshot): Promise<void> {
  stack.push(snapshot);
  try {
    await hooks?.onPush?.(snapshot);
  } catch (err) {
    // The file write already succeeded; failing the tool over checkpoint
    // persistence would make the model retry the same write.
    if (process.env.STAR_DEBUG) {
      console.error("[star] failed to persist snapshot checkpoint:", err);
    }
  }
  if (stack.length > MAX_SNAPSHOTS) {
    const evicted = stack.splice(0, stack.length - MAX_SNAPSHOTS);
    await removeFromStore(evicted.map((s) => s.id));
  }
}

async function removeFromStore(ids: number[]): Promise<void> {
  if (ids.length > 0) await hooks?.onRemove?.(ids);
}

export function snapshotCount(): number {
  return stack.length;
}

export function listSnapshots(): FileSnapshot[] {
  return [...stack];
}

export function clearSnapshots(): void {
  stack.length = 0;
}

// Replaces the in-memory stack with checkpoints loaded from a resumed
// session's persisted records. The id counter is advanced past the loaded
// records so new checkpoints never collide with persisted ones.
export function hydrateSnapshots(snapshots: FileSnapshot[]): void {
  stack.length = 0;
  stack.push(...snapshots.slice(-MAX_SNAPSHOTS));
  for (const snapshot of stack) {
    if (snapshot.id > checkpointSeq) checkpointSeq = snapshot.id;
  }
}

async function resolveContent(snapshot: FileSnapshot): Promise<string | null> {
  if (snapshot.content !== null) return snapshot.content;
  if (!snapshot.contentFile) return null;
  try {
    return await readFile(snapshot.contentFile, "utf8");
  } catch {
    return null;
  }
}

async function revert(snapshot: FileSnapshot): Promise<string> {
  if (snapshot.existed) {
    if (snapshot.contentTooLarge) {
      return `Skipped ${snapshot.path}: content too large, not restored.`;
    }
    const content = await resolveContent(snapshot);
    if (content === null) {
      return `Skipped ${snapshot.path}: the snapshot content is no longer available.`;
    }
    await mkdir(path.dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, content, "utf8");
    return `Restored ${snapshot.path} to its state before ${snapshot.toolName}.`;
  }
  await rm(snapshot.path, { force: true });
  return `Deleted ${snapshot.path} (it did not exist before ${snapshot.toolName}).`;
}

export async function undoLastSnapshot(): Promise<string> {
  const snapshot = stack[stack.length - 1];
  if (!snapshot) {
    return "Nothing to undo (/undo only reverts file changes made by write_file/edit_file, and none are recorded yet).";
  }
  try {
    const message = await revert(snapshot);
    stack.pop();
    await removeFromStore([snapshot.id]);
    return message;
  } catch (err) {
    return `Failed to revert ${snapshot.path}: ${(err as Error).message} (checkpoint kept)`;
  }
}

// Read-only view of the snapshots a turn-scoped /undo would revert, in the
// same newest-first order undoTurnSnapshots applies them. Subagent snapshots
// are excluded unless includeSubagent is set.
export function listTurnSnapshots(turn: number, includeSubagent = false): FileSnapshot[] {
  return stack
    .filter(
      (snapshot) => snapshot.turn === turn && (includeSubagent || ownerOf(snapshot) === "root"),
    )
    .reverse();
}

// Old content of a snapshot, reading the persisted content file when the
// snapshot was hydrated from a resumed session. Exported for the read-only
// /undo preview; revert() uses the same path.
export function resolveSnapshotContent(snapshot: FileSnapshot): Promise<string | null> {
  return resolveContent(snapshot);
}

// Reverts every snapshot created by the given turn, newest first, and leaves
// snapshots from other turns untouched. A snapshot that fails to revert stays
// on the stack (and keeps its persisted checkpoint); the returned messages
// report each file's outcome.
export async function undoTurnSnapshots(turn: number, includeSubagent = false): Promise<string[]> {
  const matches: FileSnapshot[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const snapshot = stack[i];
    if (snapshot && snapshot.turn === turn && (includeSubagent || ownerOf(snapshot) === "root")) {
      matches.push(snapshot);
    }
  }
  const messages: string[] = [];
  const revertedIds: number[] = [];
  for (const snapshot of matches) {
    try {
      messages.push(await revert(snapshot));
      const idx = stack.indexOf(snapshot);
      if (idx >= 0) stack.splice(idx, 1);
      revertedIds.push(snapshot.id);
    } catch (err) {
      messages.push(
        `Failed to revert ${snapshot.path}: ${(err as Error).message} (checkpoint kept)`,
      );
    }
  }
  await removeFromStore(revertedIds);
  return messages;
}

export interface RewindResult {
  reverted: string[];
  // Smallest conversation message index among the reverted snapshots; the
  // caller retracts the conversation back to this point. null when none of
  // the reverted snapshots carries turn context.
  messageIndex: number | null;
}

// Reverts every snapshot from checkpoint `id` onwards, newest first, restoring
// the file state as it was just before that checkpoint. Successfully reverted
// snapshots are dropped from the stack (and from the persisted store via
// hooks); a snapshot that fails to revert stays on the stack, keeps its
// persisted checkpoint, and gets a failure line in the result.
export async function rewindToSnapshot(
  id: number,
  includeSubagent = false,
): Promise<RewindResult | null> {
  if (!stack.some((snapshot) => snapshot.id === id)) return null;
  const matches: FileSnapshot[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const snapshot = stack[i];
    if (snapshot && snapshot.id >= id && (includeSubagent || ownerOf(snapshot) === "root")) {
      matches.push(snapshot);
    }
  }
  const reverted: string[] = [];
  const revertedIds: number[] = [];
  let messageIndex: number | null = null;
  for (const snapshot of matches) {
    try {
      reverted.push(await revert(snapshot));
      const idx = stack.indexOf(snapshot);
      if (idx >= 0) stack.splice(idx, 1);
      revertedIds.push(snapshot.id);
      if (snapshot.messageIndex >= 0) {
        messageIndex =
          messageIndex === null
            ? snapshot.messageIndex
            : Math.min(messageIndex, snapshot.messageIndex);
      }
    } catch (err) {
      reverted.push(
        `Failed to revert ${snapshot.path}: ${(err as Error).message} (checkpoint kept)`,
      );
    }
  }
  await removeFromStore(revertedIds);
  return { reverted, messageIndex };
}
