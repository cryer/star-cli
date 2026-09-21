import fs from "node:fs/promises";
import path from "node:path";
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

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;

  private pendingMeta: { cwd: string; model: string; createdAt: number } | null = null;
  private initialized = false;

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
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      try {
        const raw = await fs.readFile(path.join(sessionsDir(), entry, "meta.json"), "utf8");
        const meta = JSON.parse(raw) as SessionMeta;
        if (meta.id === entry && (cwd === undefined || meta.cwd === cwd)) metas.push(meta);
      } catch {
        // 跳过损坏的会话目录
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const pending = this.pendingMeta;
    if (!pending) {
      this.initialized = true;
      return;
    }
    await fs.mkdir(this.dir, { recursive: true });
    const meta: SessionMeta = {
      id: this.id,
      title: "",
      model: pending.model,
      cwd: pending.cwd,
      createdAt: pending.createdAt,
      updatedAt: pending.createdAt,
    };
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
    this.initialized = true;
  }

  async append(message: CoreMessage): Promise<void> {
    await this.ensureInitialized();
    await fs.appendFile(this.messagesPath(), `${JSON.stringify(message)}\n`);
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
  }

  async replaceMessages(messages: CoreMessage[]): Promise<void> {
    await this.ensureInitialized();
    const content = messages.map((message) => JSON.stringify(message)).join("\n");
    await fs.writeFile(this.messagesPath(), content ? `${content}\n` : "");
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
  }

  async messages(): Promise<CoreMessage[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.messagesPath(), "utf8");
    } catch {
      return [];
    }
    const messages: CoreMessage[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed) as CoreMessage);
      } catch {
        debugWarn(`session ${this.id}: skipping corrupt messages.jsonl line`);
      }
    }
    return messages;
  }

  private fallbackMeta(): SessionMeta {
    const now = Date.now();
    return { id: this.id, title: "", model: "", cwd: "", createdAt: now, updatedAt: now };
  }

  async meta(): Promise<SessionMeta> {
    await this.ensureInitialized();
    try {
      const raw = await fs.readFile(this.metaPath(), "utf8");
      return JSON.parse(raw) as SessionMeta;
    } catch {
      debugWarn(`session ${this.id}: unreadable meta.json, using defaults`);
      return this.fallbackMeta();
    }
  }

  async setTitle(title: string): Promise<void> {
    await this.ensureInitialized();
    const meta = await this.meta();
    meta.title = title;
    meta.updatedAt = Date.now();
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
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
    meta.usage = usage;
    const day = dayKey(new Date());
    const byDay = meta.usageByDay ?? {};
    const bucket = byDay[day] ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    bucket.promptTokens += delta.promptTokens;
    bucket.completionTokens += delta.completionTokens;
    bucket.totalTokens += delta.totalTokens;
    byDay[day] = bucket;
    meta.usageByDay = byDay;
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
  }
}
