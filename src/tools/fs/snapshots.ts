import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string | null;
  toolName: string;
  timestamp: number;
  // Seq of the conversation turn that produced this snapshot (0 = no turn
  // context, e.g. direct tool use in tests). Monotonically increasing per
  // process, so a turn's snapshots can be reverted without touching older ones.
  turn: number;
}

const MAX_SNAPSHOTS = 50;

const stack: FileSnapshot[] = [];
let activeTurn = 0;

// Called by the agent loop at the start of every conversation turn; returns
// the seq assigned to the turn. Tool-made snapshots record this seq.
export function beginTurn(): number {
  return ++activeTurn;
}

export function currentTurnSeq(): number {
  return activeTurn;
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
  return { path: filePath, existed, content, toolName, timestamp: Date.now(), turn: activeTurn };
}

export function pushSnapshot(snapshot: FileSnapshot): void {
  stack.push(snapshot);
  if (stack.length > MAX_SNAPSHOTS) {
    stack.splice(0, stack.length - MAX_SNAPSHOTS);
  }
}

export function snapshotCount(): number {
  return stack.length;
}

export function clearSnapshots(): void {
  stack.length = 0;
}

async function revert(snapshot: FileSnapshot): Promise<string> {
  if (snapshot.existed && snapshot.content !== null) {
    await mkdir(path.dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, snapshot.content, "utf8");
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
  return revert(snapshot);
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
  const messages: string[] = [];
  for (const snapshot of matches) {
    messages.push(await revert(snapshot));
  }
  return messages;
}
