import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sessionsDir } from "../config/paths";
import type { CoreMessage, MessageMeta, StarMessage } from "../core/messages";
import {
  type CheckpointRecord,
  appendCheckpointRecord,
  listCheckpointRecords,
  removeCheckpointRecords,
} from "./checkpoints";
import { type SessionLock, SessionLockedError, acquireSessionLock } from "./lock";

export { SessionLockedError } from "./lock";

export interface SessionUsage {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedPromptTokens?: number;
  cacheReadInputTokens?: number;
  costUsd?: number;
  costUnknown?: boolean;
}

export interface UsageAttribution {
  modelName: string;
  costUsd: number | null;
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
  usageByModel?: Record<string, SessionUsage>;
}

function generateId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${suffix}`;
}

// Two processes creating a session in the same second share the timestamp
// stamp, and a colliding random suffix would merge both sessions into one
// directory — so an occupied id is redrawn a few times and ultimately widened
// with a randomUUID segment.
const ID_COLLISION_MAX_ATTEMPTS = 5;

function generateUniqueId(): string {
  let id = generateId(new Date());
  for (let attempt = 1; existsSync(path.join(sessionsDir(), id)); attempt++) {
    if (attempt >= ID_COLLISION_MAX_ATTEMPTS) {
      const stamp = id.slice(0, id.lastIndexOf("-"));
      return `${stamp}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
    id = generateId(new Date());
  }
  return id;
}

// Sessions record their owning cwd as a raw string, but on Windows the same
// directory shows up with different drive-letter casing and trailing
// separators; comparing raw strings would orphan those sessions from the
// `star -c` / list filter. win32 comparisons resolve both sides and fold
// case; POSIX paths are case-sensitive and stay as recorded.
export function normalizeCwdForCompare(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return cwd;
  const resolved = path.win32.resolve(cwd);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return (trimmed === "" ? resolved : trimmed).toLowerCase();
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

export async function withTransientFsRetry(operation: () => Promise<unknown>): Promise<void> {
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

// Loop side-band metadata (MessageMeta) persists as an extra key on the
// message's jsonl row; readers strip it, so older rows without the key and
// older readers unaware of it both keep working.
const STAR_META_KEY = "__starMeta";

function serializeMessage(star: StarMessage): string {
  if (!star.meta) return JSON.stringify(star.message);
  return JSON.stringify({ ...star.message, [STAR_META_KEY]: star.meta });
}

function parseMessageLine(line: string): StarMessage | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed !== null && typeof parsed === "object" && STAR_META_KEY in parsed) {
      const { [STAR_META_KEY]: meta, ...message } = parsed;
      return { message: message as unknown as CoreMessage, meta: meta as MessageMeta };
    }
    return { message: parsed as unknown as CoreMessage };
  } catch {
    return null;
  }
}

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;

  private pendingMeta: { cwd: string; model: string; createdAt: number } | null = null;
  private initialized = false;
  private initialization: Promise<void> | null = null;
  private cachedMeta: SessionMeta | null = null;
  private lock: SessionLock | null = null;
  private closing = false;
  private closed = false;
  private messageHistory: StarMessage[] | null = null;
  private degraded = false;
  private messageWriteQueue: Promise<void> = Promise.resolve();
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
    for (let attempt = 0; attempt < ID_COLLISION_MAX_ATTEMPTS; attempt++) {
      const store = new SessionStore(generateUniqueId());
      try {
        store.lock = await acquireSessionLock(store.dir, store.id);
      } catch (error) {
        if (error instanceof SessionLockedError) continue;
        throw error;
      }
      store.pendingMeta = { cwd, model, createdAt: Date.now() };
      store.messageHistory = [];
      return store;
    }
    throw new Error("Could not allocate an exclusive session id");
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
      debugWarn(`session ${id}: corrupt meta.json, using defaults`);
    }
    store.lock = await acquireSessionLock(store.dir, id);
    try {
      await store.sweepTmpFiles();
      store.initialized = true;
      return store;
    } catch (error) {
      await store.lock.release();
      throw error;
    }
  }

  static async list(cwd?: string): Promise<SessionMeta[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(sessionsDir());
    } catch {
      return [];
    }
    const wanted = cwd === undefined ? undefined : normalizeCwdForCompare(cwd);
    const metas: (SessionMeta | null)[] = [];
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const index = next;
        next += 1;
        const entry = entries[index];
        if (!entry) continue;
        try {
          const raw = await fs.readFile(path.join(sessionsDir(), entry, "meta.json"), "utf8");
          const meta = JSON.parse(raw) as SessionMeta;
          if (
            meta.id === entry &&
            (wanted === undefined || normalizeCwdForCompare(meta.cwd) === wanted)
          ) {
            metas[index] = meta;
          }
        } catch {
          // Skip unreadable and corrupt session directories.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, entries.length) }, () => worker()));
    return metas
      .filter((meta): meta is SessionMeta => meta !== null && meta !== undefined)
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
    const tmp = `${this.metaPath()}.tmp-${process.pid}-${randomUUID()}`;
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

  private async flushMetaNow(): Promise<void> {
    if (this.metaFlushTimer) {
      clearTimeout(this.metaFlushTimer);
      this.metaFlushTimer = null;
    }
    this.metaDirty = false;
    this.metaLastFlushAt = Date.now();
    if (this.cachedMeta) await this.writeMeta(this.cachedMeta);
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    try {
      await this.messageWriteQueue;
      await this.flushMetaIfDirty();
      await this.metaWriteQueue;
    } finally {
      if (this.metaFlushTimer) clearTimeout(this.metaFlushTimer);
      this.metaFlushTimer = null;
      this.closed = true;
      this.closing = false;
      const lock = this.lock;
      this.lock = null;
      await lock?.release();
    }
  }

  private assertCanWrite(): void {
    if (this.closed || this.closing || !this.lock) {
      throw new Error(`Session store is closed: ${this.id}`);
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      const pending = this.pendingMeta;
      if (!pending) {
        this.initialized = true;
        return;
      }
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
    })();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = null;
      throw error;
    }
  }

  private async sweepTmpFiles(): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const match = /^(?:meta\.json|messages\.jsonl)\.tmp-(\d+)-/.exec(entry);
        if (!match) return;
        const pid = Number(match[1]);
        try {
          process.kill(pid, 0);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") return;
        }
        await fs.unlink(path.join(this.dir, entry)).catch(() => {});
      }),
    );
  }

  private enqueueMessageWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.messageWriteQueue.then(operation);
    this.messageWriteQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  get persistenceDegraded(): boolean {
    return this.degraded;
  }

  private async ensureMessageHistory(): Promise<StarMessage[]> {
    if (!this.messageHistory) this.messageHistory = await this.readStarMessages(true);
    return this.messageHistory;
  }

  private async rewriteMessages(messages: readonly StarMessage[]): Promise<boolean> {
    await this.ensureInitialized();
    this.messageHistory = [...messages];
    const content = messages.map(serializeMessage).join("\n");
    const tmp = `${this.messagesPath()}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await withTransientFsRetry(async () => {
        await fs.writeFile(tmp, content ? `${content}\n` : "");
        await fs.rename(tmp, this.messagesPath());
      });
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      this.degraded = true;
      warn(
        `session ${this.id}: history rewrite failed (${(error as NodeJS.ErrnoException).code ?? String(error)}), kept the previous messages.jsonl`,
      );
      return false;
    }
    this.degraded = false;
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    await this.flushMetaNow();
    return true;
  }

  async append(message: CoreMessage, meta?: MessageMeta): Promise<boolean> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      await this.ensureInitialized();
      const history = await this.ensureMessageHistory();
      const star = { message, meta };
      if (this.degraded) return this.rewriteMessages([...history, star]);
      try {
        await withTransientFsRetry(() =>
          fs.appendFile(this.messagesPath(), `${serializeMessage(star)}\n`),
        );
      } catch (error) {
        this.messageHistory = [...history, star];
        this.degraded = true;
        warn(
          `session ${this.id}: message append failed (${(error as NodeJS.ErrnoException).code ?? String(error)}), full history rewrite required`,
        );
        return false;
      }
      history.push(star);
      const sessionMeta = await this.meta();
      sessionMeta.updatedAt = Date.now();
      this.markMetaDirty();
      return true;
    });
  }

  async replaceMessages(messages: readonly StarMessage[]): Promise<boolean> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(() => this.rewriteMessages(messages));
  }

  async recoverMessages(): Promise<boolean> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      if (!this.degraded) return true;
      return this.rewriteMessages(await this.ensureMessageHistory());
    });
  }

  async messages(): Promise<CoreMessage[]> {
    return (await this.starMessages()).map((star) => star.message);
  }

  async starMessages(): Promise<StarMessage[]> {
    return this.readStarMessages(false);
  }

  private async readStarMessages(strict: boolean): Promise<StarMessage[]> {
    // Read in fixed-size chunks through a StringDecoder instead of buffering
    // the whole file: a resume used to hold the raw string, the split line
    // array and the parsed objects at once (3-4x the file size at peak). The
    // parsed history is now the only large allocation. Corrupt lines are
    // still skipped; an unreadable file still yields an empty history.
    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(this.messagesPath(), "r");
      const messages: StarMessage[] = [];
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(MESSAGES_READ_CHUNK_BYTES);
      let tail = "";
      const pushLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const parsed = parseMessageLine(trimmed);
        if (parsed) {
          messages.push(parsed);
        } else {
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
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      await this.ensureInitialized();
      const meta = await this.meta();
      meta.title = title;
      meta.updatedAt = Date.now();
      await this.flushMetaNow();
    });
  }

  // /model swaps the live loop mid-session; keep the recorded model in sync
  // or the session list and /usage attribute the whole session to whichever
  // model happened to be active at creation.
  async setModel(model: string): Promise<void> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      await this.ensureInitialized();
      const meta = await this.meta();
      meta.model = model;
      meta.updatedAt = Date.now();
      await this.flushMetaNow();
    });
  }

  async appendCheckpoint(record: CheckpointRecord, content: string | Buffer | null): Promise<void> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      await this.ensureInitialized();
      await appendCheckpointRecord(this.dir, record, content);
    });
  }

  async listCheckpoints(): Promise<CheckpointRecord[]> {
    return listCheckpointRecords(this.dir);
  }

  async removeCheckpoints(ids: number[]): Promise<void> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(() => removeCheckpointRecords(this.dir, ids));
  }

  async addUsage(
    delta: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cachedPromptTokens?: number;
      cacheReadInputTokens?: number;
    },
    attribution?: UsageAttribution,
  ): Promise<void> {
    this.assertCanWrite();
    return this.enqueueMessageWrite(async () => {
      await this.ensureInitialized();
      const meta = await this.meta();
      const apply = (usage: SessionUsage) => {
        usage.requests += 1;
        usage.promptTokens += delta.promptTokens;
        usage.completionTokens += delta.completionTokens;
        usage.totalTokens += delta.totalTokens;
        if (delta.cachedPromptTokens) {
          usage.cachedPromptTokens = (usage.cachedPromptTokens ?? 0) + delta.cachedPromptTokens;
        }
        if (delta.cacheReadInputTokens) {
          usage.cacheReadInputTokens =
            (usage.cacheReadInputTokens ?? 0) + delta.cacheReadInputTokens;
        }
        if (attribution) {
          if (attribution.costUsd === null) usage.costUnknown = true;
          else usage.costUsd = (usage.costUsd ?? 0) + attribution.costUsd;
        }
      };
      const usage = meta.usage ?? {
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      apply(usage);
      meta.usage = usage;
      if (attribution) {
        const byModel = meta.usageByModel ?? {};
        const modelUsage = byModel[attribution.modelName] ?? {
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        };
        apply(modelUsage);
        byModel[attribution.modelName] = modelUsage;
        meta.usageByModel = byModel;
      }
      const day = dayKey(new Date());
      const byDay = meta.usageByDay ?? {};
      const bucket = byDay[day] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      bucket.promptTokens += delta.promptTokens;
      bucket.completionTokens += delta.completionTokens;
      bucket.totalTokens += delta.totalTokens;
      byDay[day] = bucket;
      meta.usageByDay = byDay;
      await this.flushMetaNow();
    });
  }
}
