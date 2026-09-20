import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileSnapshot {
  path: string;
  existed: boolean;
  content: string | null;
  toolName: string;
  timestamp: number;
}

const MAX_SNAPSHOTS = 50;

const stack: FileSnapshot[] = [];

export async function captureSnapshot(filePath: string, toolName: string): Promise<FileSnapshot> {
  let content: string | null = null;
  let existed = false;
  try {
    content = await readFile(filePath, "utf8");
    existed = true;
  } catch {
    // file does not exist or is unreadable; recorded as non-existent
  }
  return { path: filePath, existed, content, toolName, timestamp: Date.now() };
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

export async function undoLastSnapshot(): Promise<string> {
  const snapshot = stack.pop();
  if (!snapshot) {
    return "Nothing to undo (/undo only reverts file changes made by write_file/edit_file, and none are recorded yet).";
  }
  if (snapshot.existed && snapshot.content !== null) {
    await mkdir(path.dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, snapshot.content, "utf8");
    return `Restored ${snapshot.path} to its state before ${snapshot.toolName}.`;
  }
  await rm(snapshot.path, { force: true });
  return `Deleted ${snapshot.path} (it did not exist before ${snapshot.toolName}).`;
}
