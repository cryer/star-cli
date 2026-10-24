import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const LOCK_FILENAME = ".lock";
const RECLAIM_FILENAME = ".lock.reclaim";
const MALFORMED_LOCK_GRACE_MS = 5000;
const RECLAIM_STALE_MS = 30_000;

interface LockRecord {
  pid: number;
  token: string;
  createdAt: number;
}

export class SessionLockedError extends Error {
  readonly code = "SESSION_LOCKED";

  constructor(readonly sessionId: string) {
    super(`Session is already open in another process: ${sessionId}`);
    this.name = "SessionLockedError";
  }
}

export interface SessionLock {
  release(): Promise<void>;
}

function lockPath(sessionDir: string): string {
  return path.join(sessionDir, LOCK_FILENAME);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockRecord(file: string): Promise<LockRecord | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<LockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.token !== "string" ||
      typeof parsed.createdAt !== "number"
    ) {
      return null;
    }
    return { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

async function malformedLockIsStale(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return Date.now() - stat.mtimeMs >= MALFORMED_LOCK_GRACE_MS;
  } catch {
    return false;
  }
}

async function reclaimStaleLock(sessionDir: string, expected: LockRecord | null): Promise<boolean> {
  const guard = path.join(sessionDir, RECLAIM_FILENAME);
  let guardHandle: fs.FileHandle;
  try {
    guardHandle = await fs.open(guard, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      const stat = await fs.stat(guard);
      if (Date.now() - stat.mtimeMs < RECLAIM_STALE_MS) return false;
      await fs.unlink(guard);
    } catch {
      return false;
    }
    return false;
  }

  const quarantine = `${lockPath(sessionDir)}.stale-${process.pid}-${randomUUID()}`;
  try {
    const file = lockPath(sessionDir);
    const current = await readLockRecord(file);
    if (expected) {
      if (current?.token !== expected.token || processIsAlive(current.pid)) return false;
    } else {
      if (current) {
        if (processIsAlive(current.pid)) return false;
      } else if (!(await malformedLockIsStale(file))) {
        return false;
      }
    }
    await fs.rename(file, quarantine);
    await fs.unlink(quarantine).catch(() => {});
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  } finally {
    await guardHandle.close().catch(() => {});
    await fs.unlink(guard).catch(() => {});
  }
}

export async function acquireSessionLock(
  sessionDir: string,
  sessionId: string,
): Promise<SessionLock> {
  await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const file = lockPath(sessionDir);
  const record: LockRecord = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };

  for (let attempt = 0; attempt < 20; attempt++) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLockRecord(file);
      if (existing ? processIsAlive(existing.pid) : !(await malformedLockIsStale(file))) {
        throw new SessionLockedError(sessionId);
      }
      if (!(await reclaimStaleLock(sessionDir, existing))) {
        const current = await readLockRecord(file);
        if (current && processIsAlive(current.pid)) throw new SessionLockedError(sessionId);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      continue;
    }

    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.close();
      return {
        release: async () => {
          if ((await readLockRecord(file))?.token === record.token) {
            await fs.unlink(file).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error;
            });
          }
        },
      };
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.unlink(file).catch(() => {});
      throw error;
    }
  }
  throw new SessionLockedError(sessionId);
}
