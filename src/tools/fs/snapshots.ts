import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
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
  // Pre-change content. Held in memory only between captureSnapshot and
  // pushSnapshot (which spills it to disk); afterwards null and read lazily
  // from contentFile, so a full stack of large files costs no RAM. Raw bytes
  // (Buffer) end to end so binary files survive capture → spill → restore
  // byte-exact; a utf8 round-trip would corrupt them with U+FFFD. edit_file
  // still pushes a string (it only edits text) — written back as utf8.
  content: string | Buffer | null;
  // Set when the pre-change content exceeded MAX_SNAPSHOT_CONTENT_BYTES: only
  // metadata is kept (no content, no persisted content file) and revert()
  // skips the file instead of restoring it.
  contentTooLarge?: boolean;
  // Lazy source for the old content once it left memory: the per-process
  // spill file (pushed snapshots) or the persisted session checkpoint content
  // file (snapshots hydrated from a resumed session).
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

// Spilled snapshot contents live in a per-process temp directory (unique per
// module instance so parallel test workers never collide) and are deleted
// when their snapshot leaves the stack. Spilling is a memory optimization
// only: on any failure the content just stays in memory.
const spillDir = path.join(
  os.tmpdir(),
  `star-cli-snapshots-${process.pid}-${randomUUID().slice(0, 8)}`,
);

function isSpillPath(p: string): boolean {
  return p.startsWith(spillDir + path.sep);
}

async function spillContent(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.content === null || snapshot.contentFile) return;
  try {
    const file = path.join(spillDir, `${snapshot.id}.snap`);
    await mkdir(spillDir, { recursive: true, mode: 0o700 });
    // Strings default to utf8 (same as before); Buffers are written raw so
    // binary snapshots spill byte-exact.
    await writeFile(file, snapshot.content, { mode: 0o600 });
    snapshot.contentFile = file;
    snapshot.content = null;
  } catch {
    // keep the content in memory
  }
}

// Deletes the spill file of a snapshot leaving the stack. Never touches a
// contentFile that points at a persisted session checkpoint — the onRemove
// hook owns those.
async function discardSpill(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contentFile && isSpillPath(snapshot.contentFile)) {
    await rm(snapshot.contentFile, { force: true }).catch(() => {});
  }
}

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
  let content: string | Buffer | null = null;
  let existed = false;
  let contentTooLarge = false;
  const st = await stat(filePath).catch(() => null);
  if (st?.isFile()) {
    existed = true;
    if (st.size > MAX_SNAPSHOT_CONTENT_BYTES) {
      contentTooLarge = true;
    } else {
      try {
        // No encoding: capture the raw bytes so a later restore is byte-exact
        // even for binary files (write_file may overwrite one).
        content = await readFile(filePath);
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
    // Hooks run before the spill: checkpoint persistence reads
    // snapshot.content, which the spill then clears.
    await hooks?.onPush?.(snapshot);
  } catch (err) {
    // The file write already succeeded; failing the tool over checkpoint
    // persistence would make the model retry the same write.
    if (process.env.STAR_DEBUG) {
      console.error("[star] failed to persist snapshot checkpoint:", err);
    }
  }
  await spillContent(snapshot);
  if (stack.length > MAX_SNAPSHOTS) {
    const evicted = stack.splice(0, stack.length - MAX_SNAPSHOTS);
    for (const old of evicted) await discardSpill(old);
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
  for (const snapshot of stack) void discardSpill(snapshot);
  stack.length = 0;
}

// Replaces the in-memory stack with checkpoints loaded from a resumed
// session's persisted records. The id counter is advanced past the loaded
// records so new checkpoints never collide with persisted ones.
export function hydrateSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of stack) void discardSpill(snapshot);
  stack.length = 0;
  stack.push(...snapshots.slice(-MAX_SNAPSHOTS));
  for (const snapshot of stack) {
    if (snapshot.id > checkpointSeq) checkpointSeq = snapshot.id;
  }
}

async function resolveContent(snapshot: FileSnapshot): Promise<string | Buffer | null> {
  if (snapshot.content !== null) return snapshot.content;
  if (!snapshot.contentFile) return null;
  try {
    // No encoding: the spill/checkpoint file holds raw bytes (utf8 for
    // string-origin content), and revert writes them back verbatim.
    return await readFile(snapshot.contentFile);
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
    await writeFile(snapshot.path, content);
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
    await discardSpill(snapshot);
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

// Old content of a snapshot, read lazily from the spill file or the
// persisted session checkpoint content file. Exported for the read-only
// /undo preview; revert() uses the same path. Binary snapshots decode
// lossy here — the preview is display-only, restores stay byte-exact.
export async function resolveSnapshotContent(snapshot: FileSnapshot): Promise<string | null> {
  const content = await resolveContent(snapshot);
  if (content === null) return null;
  return typeof content === "string" ? content : content.toString("utf8");
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
      await discardSpill(snapshot);
    } catch (err) {
      messages.push(
        `Failed to revert ${snapshot.path}: ${(err as Error).message} (checkpoint kept)`,
      );
    }
  }
  await removeFromStore(revertedIds);
  return messages;
}

// Removes a turn's snapshots from the stack and the persisted store WITHOUT
// reverting them: the git-tree /undo path already restored the whole working
// tree, so replaying the per-file reverts would double-restore. Returns the
// number of dropped snapshots.
export async function dropTurnSnapshots(turn: number, includeSubagent = false): Promise<number> {
  const dropped: number[] = [];
  const droppedSnapshots: FileSnapshot[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const snapshot = stack[i];
    if (snapshot && snapshot.turn === turn && (includeSubagent || ownerOf(snapshot) === "root")) {
      dropped.push(snapshot.id);
      droppedSnapshots.push(snapshot);
      stack.splice(i, 1);
    }
  }
  for (const snapshot of droppedSnapshots) await discardSpill(snapshot);
  await removeFromStore(dropped);
  return dropped.length;
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
      await discardSpill(snapshot);
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
