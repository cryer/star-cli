import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionsDir } from "../config/paths";
import type { CoreMessage } from "../core/messages";
import {
  type CheckpointRecord,
  appendCheckpointRecord,
  listCheckpointRecords,
  removeCheckpointRecords,
} from "./checkpoints";

export interface SessionUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Prompt-cache totals; present only after a provider reports cache fields.
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
}

export interface DayUsageBucket {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  usage?: SessionUsage;
  // Per-day token buckets keyed by local date (YYYY-MM-DD), recorded alongside
  // `usage` from the day this field was introduced; older sessions only have
  // the grand totals in `usage`.
  usageByDay?: Record<string, DayUsageBucket>;
}

function generateId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${suffix}`;
}

function debugWarn(message: string): void {
  if (process.env.STAR_DEBUG === "1") process.stderr.write(`[star-cli] ${message}\n`);
}

// Persistent message-write failures surface unconditionally (unlike
// debugWarn): a dropped append means the line is missing after a resume.
function warn(message: string): void {
  process.stderr.write(`[star-cli] ${message}\n`);
}

// Windows antivirus and search indexers briefly lock freshly written files,
// so a write or rename right after the touch can come back EPERM/EACCES/EBUSY;
// a few short retries ride out the scan. Shared by meta writes, message
// appends and history rewrites.
const FS_WRITE_MAX_ATTEMPTS = 5;
const FS_WRITE_RETRY_DELAY_MS = 25;

function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

async function withTransientFsRetry(operation: () => Promise<unknown>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FS_WRITE_MAX_ATTEMPTS; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      lastError = error;
      if (isTransientFsError(error) && attempt + 1 < FS_WRITE_MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, FS_WRITE_RETRY_DELAY_MS * (attempt + 1)),
        );
      } else {
        break;
      }
    }
  }
  throw lastError;
}

// Brands the fallback meta returned for a corrupt/unreadable meta.json so
// writeMeta can refuse to persist it: writing the empty defaults back would
// wipe the real model/cwd/usage fields still sitting in the damaged file.
const FALLBACK_META: unique symbol = Symbol("star.fallbackMeta");

function isFallbackMeta(meta: SessionMeta): boolean {
  return (meta as unknown as Record<symbol, unknown>)[FALLBACK_META] === true;
}

// append() bumps only meta.updatedAt, so those writes are debounced: at most
// one meta flush per window during a burst plus a trailing flush after it
// settles (a 30-tool-call turn appends ~60 messages, and each used to land
// its own atomic tmp+rename meta write). Substantive changes (title, usage,
// history rewrites, the initial write) still flush immediately.
const META_FLUSH_INTERVAL_MS = 2000;

// messages.jsonl is read back in chunks of this size instead of buffering
// the whole file (a resume used to peak at 3-4x the file size in memory).
const MESSAGES_READ_CHUNK_BYTES = 64 * 1024;

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;

  private pendingMeta: { cwd: string; model: string; createdAt: number } | null = null;
  private initialized = false;
  private cachedMeta: SessionMeta | null = null;
  private metaTmpSeq = 0;
  private messagesTmpSeq = 0;
  private metaWriteQueue: Promise<void> = Promise.resolve();
  private metaLastFlushAt = 0;
  private metaFlushTimer: NodeJS.Timeout | null = null;
  private metaDirty = false;

  private constructor(id: string) {
    this.id = id;
    this.dir = path.join(sessionsDir(), id);
  }

  private metaPath(): string {
    return path.join(this.dir, "meta.json");
  }

  private messagesPath(): string {
    return path.join(this.dir, "messages.jsonl");
  }

  static async create(cwd: string, model: string): Promise<SessionStore> {
    const store = new SessionStore(generateId(new Date()));
    store.pendingMeta = { cwd, model, createdAt: Date.now() };
    return store;
  }

  static async open(id: string): Promise<SessionStore | null> {
    const store = new SessionStore(id);
    let raw: string;
    try {
      raw = await fs.readFile(store.metaPath(), "utf8");
    } catch {
      return null;
    }
    try {
      const meta = JSON.parse(raw) as SessionMeta;
      if (meta.id !== id) return null;
    } catch {
      // meta.json is corrupt (e.g. truncated write); open anyway and let
      // meta() fall back to defaults so messages stay resumable.
      debugWarn(`session ${id}: corrupt meta.json, using defaults`);
    }
    await store.sweepTmpFiles();
    store.initialized = true;
    return store;
  }

  static async list(cwd?: string): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(sessionsDir());
    } catch {
      return [];
    }
    const metas = await Promise.all(
      entries.map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(sessionsDir(), entry, "meta.json"), "utf8");
          const meta = JSON.parse(raw) as SessionMeta;
          if (meta.id === entry && (cwd === undefined || meta.cwd === cwd)) return meta;
        } catch {
          // 跳过损坏的会话目录
        }
        return null;
      }),
    );
    return metas
      .filter((meta): meta is SessionMeta => meta !== null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Meta writes are serialized per instance and land atomically (tmp file +
  // rename) over a cached in-memory meta: the fire-and-forget title/usage
  // writers race the loop's own appends, and a truncated read once turned
  // fallbackMeta's empty defaults into a persisted wipe of model/cwd/usage.
  // A branded fallback meta is never written back for the same reason.
  // A write that still fails after retries is dropped rather than thrown:
  // meta.json is bookkeeping the cached meta rebuilds on the next write,
  // while the conversation itself lives in messages.jsonl — killing the
  // agent turn over a stale updatedAt would be the wrong trade.
  private writeMeta(meta: SessionMeta): Promise<void> {
    if (isFallbackMeta(meta)) return Promise.resolve();
    const tmp = `${this.metaPath()}.tmp-${process.pid}-${this.metaTmpSeq++}`;
    const run = this.metaWriteQueue.then(async () => {
      try {
        await withTransientFsRetry(async () => {
          await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
          await fs.rename(tmp, this.metaPath());
        });
      } catch (error) {
        await fs.unlink(tmp).catch(() => {});
        debugWarn(
          `session ${this.id}: meta write failed (${(error as NodeJS.ErrnoException).code ?? String(error)}), skipping`,
        );
      }
    });
    this.metaWriteQueue = run.catch(() => {});
    return run;
  }

  // Debounced flush for append-driven updatedAt bumps. The trailing timer is
  // unref'd so a pending flush never keeps the process alive; close() flushes
  // synchronously on a clean exit, and a hard exit simply drops the trailing
  // bump — meta is bookkeeping.
  private markMetaDirty(): void {
    this.metaDirty = true;
    if (this.metaFlushTimer) return;
    const delay = Math.max(0, META_FLUSH_INTERVAL_MS - (Date.now() - this.metaLastFlushAt));
    if (delay === 0) {
      void this.flushMetaIfDirty();
      return;
    }
    this.metaFlushTimer = setTimeout(() => {
      this.metaFlushTimer = null;
      void this.flushMetaIfDirty();
    }, delay);
    this.metaFlushTimer.unref();
  }

  private async flushMetaIfDirty(): Promise<void> {
    if (!this.metaDirty) return;
    await this.flushMetaNow();
  }

  // Immediate flush for substantive meta changes; cancels a pending debounced
  // flush, which the write makes redundant either way (it serializes the live
  // cached meta).
  private async flushMetaNow(): Promise<void> {
    if (this.metaFlushTimer) {
      clearTimeout(this.metaFlushTimer);
      this.metaFlushTimer = null;
    }
    this.metaDirty = false;
    this.metaLastFlushAt = Date.now();
    if (this.cachedMeta) await this.writeMeta(this.cachedMeta);
  }

  // Flushes a pending debounced meta write and waits for in-flight writes to
  // settle; call when the store is dropped so a clean exit keeps the trailing
  // updatedAt bump.
  async close(): Promise<void> {
    await this.flushMetaIfDirty();
    await this.metaWriteQueue;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const pending = this.pendingMeta;
    if (!pending) {
      this.initialized = true;
      return;
    }
    // Session directories hold file contents (checkpoints); keep them private
    // on shared machines. The mode is a no-op on Windows.
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await this.sweepTmpFiles();
    const meta: SessionMeta = {
      id: this.id,
      title: "",
      model: pending.model,
      cwd: pending.cwd,
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
    };
    await this.writeMeta(meta);
    this.cachedMeta = meta;
    this.metaLastFlushAt = Date.now();
    this.initialized = true;
  }

  // Removes tmp orphans left behind by crashed atomic writes (both meta.json
  // and messages.jsonl write tmp file + rename); best-effort, the directory
  // may not even exist yet.
  private async sweepTmpFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      entries
        .filter(
          (entry) => entry.startsWith("meta.json.tmp-") || entry.startsWith("messages.jsonl.tmp-"),
        )
        .map((entry) => fs.unlink(path.join(this.dir, entry)).catch(() => {})),
    );
  }

  async append(message: CoreMessage): Promise<void> {
    await this.ensureInitialized();
    // Appends get the same transient-failure retries as meta writes, and a
    // failure that outlasts them degrades to a warning instead of throwing:
    // the agent loop awaits append without a catch, so one AV-locked file
    // must not kill the whole turn. The message still lives in the loop's
    // in-memory history and later appends keep working; only this line is
    // missing from messages.jsonl after a resume.
    try {
      await withTransientFsRetry(() =>
        fs.appendFile(this.messagesPath(), `${JSON.stringify(message)}\n`),
      );
    } catch (error) {
      warn(
        `session ${this.id}: message append failed (${(error as NodeJS.ErrnoException).code ?? String(error)}), message kept in memory only`,
      );
    }
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    this.markMetaDirty();
  }

  async replaceMessages(messages: CoreMessage[]): Promise<void> {
    await this.ensureInitialized();
    const content = messages.map((message) => JSON.stringify(message)).join("\n");
    // tmp + rename like writeMeta: messages.jsonl is the session's only
    // durable record, and a crash mid-writeFile must not leave it truncated.
    // A rewrite that fails past its retries is dropped with a warning rather
    // than thrown — the previous history stays intact on disk, which is the
    // safer side to land on.
    const tmp = `${this.messagesPath()}.tmp-${process.pid}-${this.messagesTmpSeq++}`;
    try {
      await withTransientFsRetry(async () => {
        await fs.writeFile(tmp, content ? `${content}\n` : "");
        await fs.rename(tmp, this.messagesPath());
      });
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      warn(
        `session ${this.id}: history rewrite failed (${(error as NodeJS.ErrnoException).code ?? String(error)}), kept the previous messages.jsonl`,
      );
    }
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    await this.flushMetaNow();
  }

  async messages(): Promise<CoreMessage[]> {
    // Read in fixed-size chunks through a StringDecoder instead of buffering
    // the whole file: a resume used to hold the raw string, the split line
    // array and the parsed objects at once (3-4x the file size at peak). The
    // parsed history is now the only large allocation. Corrupt lines are
    // still skipped; an unreadable file still yields an empty history.
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.messagesPath(), "r");
      const messages: CoreMessage[] = [];
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(MESSAGES_READ_CHUNK_BYTES);
      let tail = "";
      const pushLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          messages.push(JSON.parse(trimmed) as CoreMessage);
        } catch {
          debugWarn(`session ${this.id}: skipping corrupt messages.jsonl line`);
        }
      };
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        const chunk = tail + decoder.write(buffer.subarray(0, bytesRead));
        const lines = chunk.split("\n");
        tail = lines.pop() ?? "";
        for (const line of lines) pushLine(line);
      }
      pushLine(tail + decoder.end());
      return messages;
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private fallbackMeta(): SessionMeta {
    const now = Date.now();
    const meta: SessionMeta = {
      id: this.id,
      title: "",
      model: "",
      cwd: "",
      createdAt: now,
      updatedAt: now,
    };
    // Non-enumerable, so it neither shows up in JSON.stringify nor spreads.
    Object.defineProperty(meta, FALLBACK_META, { value: true, enumerable: false });
    return meta;
  }

  async meta(): Promise<SessionMeta> {
    await this.ensureInitialized();
    if (this.cachedMeta) return this.cachedMeta;
    try {
      const raw = await fs.readFile(this.metaPath(), "utf8");
      this.cachedMeta = JSON.parse(raw) as SessionMeta;
      return this.cachedMeta;
    } catch {
      // The fallback is neither cached nor written back: a transient read
      // failure must not turn into a persisted wipe of the real meta.
      debugWarn(`session ${this.id}: unreadable meta.json, using defaults`);
      return this.fallbackMeta();
    }
  }

  async setTitle(title: string): Promise<void> {
    await this.ensureInitialized();
    const meta = await this.meta();
    meta.title = title;
    meta.updatedAt = Date.now();
    await this.flushMetaNow();
  }

  // /model swaps the live loop mid-session; keep the recorded model in sync
  // or the session list and /usage attribute the whole session to whichever
  // model happened to be active at creation.
  async setModel(model: string): Promise<void> {
    await this.ensureInitialized();
    const meta = await this.meta();
    meta.model = model;
    meta.updatedAt = Date.now();
    await this.flushMetaNow();
  }

  async appendCheckpoint(record: CheckpointRecord, content: string | null): Promise<void> {
    await this.ensureInitialized();
    await appendCheckpointRecord(this.dir, record, content);
  }

  async listCheckpoints(): Promise<CheckpointRecord[]> {
    return listCheckpointRecords(this.dir);
  }

  async removeCheckpoints(ids: number[]): Promise<void> {
    await removeCheckpointRecords(this.dir, ids);
  }

  async addUsage(delta: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedPromptTokens?: number;
    cacheReadInputTokens?: number;
  }): Promise<void> {
    await this.ensureInitialized();
    const meta = await this.meta();
    const usage = meta.usage ?? {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    usage.requests += 1;
    usage.promptTokens += delta.promptTokens;
    usage.completionTokens += delta.completionTokens;
    usage.totalTokens += delta.totalTokens;
    if (delta.cachedPromptTokens) {
      usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + delta.cachedPromptTokens;
    }
    if (delta.cacheReadInputTokens) {
      usage.cacheReadInputTokens = (usage.cacheReadInputTokens ?? 0) + delta.cacheReadInputTokens;
    }
    meta.usage = usage;
    const day = dayKey(new Date());
    const byDay = meta.usageByDay ?? {};
    const bucket = byDay[day] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    bucket.promptTokens += delta.promptTokens;
    bucket.completionTokens += delta.completionTokens;
    bucket.totalTokens += delta.totalTokens;
    byDay[day] = bucket;
    meta.usageByDay = byDay;
    await this.flushMetaNow();
  }
}
