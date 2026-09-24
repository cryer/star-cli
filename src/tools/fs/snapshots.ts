import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileSnapshot {
  // Checkpoint id, monotonically increasing per process (seeded from the
  // resumed session's records, so ids stay unique across resume). Assigned
  // when the snapshot is captured; failed tool calls leave gaps, which is fine.
  id: number;
  path: string;
  existed: boolean;
  content: string | null;
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
}

// Persistence callbacks, bound by the agent loop when a session store is
// attached. Every snapshot that enters or leaves the in-memory stack is
// mirrored to the session directory so /rewind works after resume.
export interface SnapshotHooks {
  onPush?(snapshot: FileSnapshot): void | Promise<void>;
  onRemove?(ids: number[]): void | Promise<void>;
}

const MAX_SNAPSHOTS = 50;

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

export async function captureSnapshot(filePath: string, toolName: string): Promise<FileSnapshot> {
  let content: string | null = null;
  let existed = false;
  try {
    content = await readFile(filePath, "utf8");
    existed = true;
  } catch {
    // file does not exist or is unreadable; recorded as non-existent
  }
  return {
    id: nextSnapshotId(),
    path: filePath,
    existed,
    content,
    toolName,
    timestamp: Date.now(),
    turn: activeTurn,
    messageIndex: activeTurnMessageIndex,
  };
}

export async function pushSnapshot(snapshot: FileSnapshot): Promise<void> {
  stack.push(snapshot);
  await hooks?.onPush?.(snapshot);
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
  const snapshot = stack.pop();
  if (!snapshot) {
    return "Nothing to undo (/undo only reverts file changes made by write_file/edit_file, and none are recorded yet).";
  }
  await removeFromStore([snapshot.id]);
  return revert(snapshot);
}

// Read-only view of the snapshots a turn-scoped /undo would revert, in the
// same newest-first order undoTurnSnapshots applies them.
export function listTurnSnapshots(turn: number): FileSnapshot[] {
  return stack.filter((snapshot) => snapshot.turn === turn).reverse();
}

// Old content of a snapshot, reading the persisted content file when the
// snapshot was hydrated from a resumed session. Exported for the read-only
// /undo preview; revert() uses the same path.
export function resolveSnapshotContent(snapshot: FileSnapshot): Promise<string | null> {
  return resolveContent(snapshot);
}

// Reverts every snapshot created by the given turn, newest first, and leaves
// snapshots from other turns untouched. Returns one message per reverted file.
export async function undoTurnSnapshots(turn: number): Promise<string[]> {
  const matches: FileSnapshot[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const snapshot = stack[i];
    if (snapshot && snapshot.turn === turn) {
      matches.push(snapshot);
      stack.splice(i, 1);
    }
  }
  await removeFromStore(matches.map((s) => s.id));
  const messages: string[] = [];
  for (const snapshot of matches) {
    messages.push(await revert(snapshot));
  }
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
// the file state as it was just before that checkpoint. The reverted snapshots
// are dropped from the stack (and from the persisted store via hooks).
export async function rewindToSnapshot(id: number): Promise<RewindResult | null> {
  if (!stack.some((snapshot) => snapshot.id === id)) return null;
  const matches: FileSnapshot[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const snapshot = stack[i];
    if (snapshot && snapshot.id >= id) {
      matches.push(snapshot);
      stack.splice(i, 1);
    }
  }
  await removeFromStore(matches.map((s) => s.id));
  const reverted: string[] = [];
  let messageIndex: number | null = null;
  for (const snapshot of matches) {
    reverted.push(await revert(snapshot));
    if (snapshot.messageIndex >= 0) {
      messageIndex =
        messageIndex === null
          ? snapshot.messageIndex
          : Math.min(messageIndex, snapshot.messageIndex);
    }
  }
  return { reverted, messageIndex };
}
