import fs from "node:fs/promises";
import path from "node:path";
import type { FileSnapshot } from "../tools/fs/snapshots";

export interface CheckpointRecord {
  id: number;
  timestamp: number;
  path: string;
  existed: boolean;
  toolName: string;
  turn: number;
  messageIndex: number;
}

function checkpointsDir(sessionDir: string): string {
  return path.join(sessionDir, "checkpoints");
}

function indexPath(sessionDir: string): string {
  return path.join(checkpointsDir(sessionDir), "index.json");
}

export function checkpointContentPath(sessionDir: string, id: number): string {
  return path.join(checkpointsDir(sessionDir), `${id}.snapshot`);
}

export async function listCheckpointRecords(sessionDir: string): Promise<CheckpointRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(indexPath(sessionDir), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as CheckpointRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Lazily creates the checkpoints directory on first use, mirroring
// SessionStore's lazy creation — a session without file writes leaves no
// checkpoints on disk.
export async function appendCheckpointRecord(
  sessionDir: string,
  record: CheckpointRecord,
  content: string | null,
): Promise<void> {
  await fs.mkdir(checkpointsDir(sessionDir), { recursive: true });
  if (record.existed && content !== null) {
    await fs.writeFile(checkpointContentPath(sessionDir, record.id), content, "utf8");
  }
  const records = await listCheckpointRecords(sessionDir);
  records.push(record);
  await fs.writeFile(indexPath(sessionDir), JSON.stringify(records, null, 2));
}

export async function removeCheckpointRecords(sessionDir: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const drop = new Set(ids);
  const records = await listCheckpointRecords(sessionDir);
  const kept = records.filter((record) => !drop.has(record.id));
  if (kept.length === records.length) return;
  await fs.mkdir(checkpointsDir(sessionDir), { recursive: true });
  await fs.writeFile(indexPath(sessionDir), JSON.stringify(kept, null, 2));
  for (const id of ids) {
    await fs.rm(checkpointContentPath(sessionDir, id), { force: true });
  }
}

// Maps persisted records back into snapshots whose content is read lazily
// from the per-checkpoint content file, for hydrating the in-memory stack
// after a session resume.
export async function loadSessionSnapshots(sessionDir: string): Promise<FileSnapshot[]> {
  const records = await listCheckpointRecords(sessionDir);
  return records.map((record) => ({
    ...record,
    content: null,
    contentFile: record.existed ? checkpointContentPath(sessionDir, record.id) : undefined,
  }));
}
