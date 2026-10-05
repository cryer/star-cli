import fs from "node:fs/promises";
import path from "node:path";
import type { FileSnapshot } from "../tools/fs/snapshots";
import { withTransientFsRetry } from "./store";

export interface CheckpointRecord {
  id: number;
  timestamp: number;
  path: string;
  existed: boolean;
  toolName: string;
  turn: number;
  messageIndex: number;
  owner?: "root" | "subagent";
  // Set when the original content exceeded the snapshot size cap: no content
  // file exists and reverts must skip the file.
  contentTooLarge?: boolean;
}

function checkpointsDir(sessionDir: string): string {
  return path.join(sessionDir, "checkpoints");
}

function indexPath(sessionDir: string): string {
  return path.join(checkpointsDir(sessionDir), "index.json");
}

// Read-modify-write on index.json is serialized per session directory, the
// same pattern as SessionStore's metaWriteQueue: the root loop and background
// subagents append checkpoints concurrently, and unprotected read-then-write
// loses records.
const indexWriteQueues = new Map<string, Promise<void>>();

function enqueueIndexWrite<T>(sessionDir: string, op: () => Promise<T>): Promise<T> {
  const queued = indexWriteQueues.get(sessionDir) ?? Promise.resolve();
  const run = queued.then(op);
  // The map entry must not outlive the queue it serializes: sessions come and
  // go, and keying by directory would otherwise grow without bound. Only
  // delete when this tail is still the latest — a newer op may have enqueued
  // behind it already.
  const tail = run.then(
    () => {},
    () => {},
  );
  indexWriteQueues.set(sessionDir, tail);
  void tail.then(() => {
    if (indexWriteQueues.get(sessionDir) === tail) indexWriteQueues.delete(sessionDir);
  });
  return run;
}

let indexTmpSeq = 0;

// index.json rewrites land atomically (tmp + rename) with the same
// transient-lock retries as the store's meta writes: a crash mid-writeFile
// would otherwise corrupt the whole /rewind index.
async function writeIndex(sessionDir: string, records: CheckpointRecord[]): Promise<void> {
  const target = indexPath(sessionDir);
  const tmp = `${target}.tmp-${process.pid}-${indexTmpSeq++}`;
  try {
    await withTransientFsRetry(async () => {
      await fs.writeFile(tmp, JSON.stringify(records, null, 2));
      await fs.rename(tmp, target);
    });
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
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
    // A missing index is normal (no checkpoints yet); a corrupt one means the
    // /rewind history was lost — say so instead of failing silently.
    process.stderr.write(
      `[star-cli] checkpoints index unreadable for session ${path.basename(sessionDir)}, ignoring it\n`,
    );
    return [];
  }
}

// Lazily creates the checkpoints directory on first use, mirroring
// SessionStore's lazy creation — a session without file writes leaves no
// checkpoints on disk.
export async function appendCheckpointRecord(
  sessionDir: string,
  record: CheckpointRecord,
  content: string | Buffer | null,
): Promise<void> {
  await enqueueIndexWrite(sessionDir, async () => {
    await fs.mkdir(checkpointsDir(sessionDir), { recursive: true, mode: 0o700 });
    if (record.existed && content !== null) {
      // writeFile ignores the encoding for Buffer data, so binary snapshots
      // persist byte-exact; string content stays utf8 as before.
      await fs.writeFile(checkpointContentPath(sessionDir, record.id), content, "utf8");
    }
    const records = await listCheckpointRecords(sessionDir);
    records.push(record);
    await writeIndex(sessionDir, records);
  });
}

export async function removeCheckpointRecords(sessionDir: string, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await enqueueIndexWrite(sessionDir, async () => {
    const drop = new Set(ids);
    const records = await listCheckpointRecords(sessionDir);
    const kept = records.filter((record) => !drop.has(record.id));
    if (kept.length === records.length) return;
    await fs.mkdir(checkpointsDir(sessionDir), { recursive: true, mode: 0o700 });
    await writeIndex(sessionDir, kept);
    for (const id of ids) {
      await fs.rm(checkpointContentPath(sessionDir, id), { force: true });
    }
  });
}

// Maps persisted records back into snapshots whose content is read lazily
// from the per-checkpoint content file, for hydrating the in-memory stack
// after a session resume.
export async function loadSessionSnapshots(sessionDir: string): Promise<FileSnapshot[]> {
  const records = await listCheckpointRecords(sessionDir);
  return records.map((record) => ({
    ...record,
    content: null,
    contentFile:
      record.existed && !record.contentTooLarge
        ? checkpointContentPath(sessionDir, record.id)
        : undefined,
  }));
}
