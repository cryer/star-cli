import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
import type { CoreMessage } from "../core/messages";

export interface SessionMeta {
  id: string;
  title: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

function generateId(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const suffix = Math.random().toString(16).slice(2, 8).padEnd(6, "0");
  return `${stamp}-${suffix}`;
}

function messageText(message: CoreMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text")
      .map((part) => ("text" in part ? part.text : ""))
      .join(" ");
  }
  return "";
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;

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
    const id = generateId(new Date());
    const store = new SessionStore(id);
    await fs.mkdir(store.dir, { recursive: true });
    const now = Date.now();
    const meta: SessionMeta = { id, title: "", model, cwd, createdAt: now, updatedAt: now };
    await fs.writeFile(store.metaPath(), JSON.stringify(meta, null, 2));
    return store;
  }

  static async open(id: string): Promise<SessionStore | null> {
    const store = new SessionStore(id);
    try {
      const raw = await fs.readFile(store.metaPath(), "utf8");
      const meta = JSON.parse(raw) as SessionMeta;
      if (meta.id !== id) return null;
      return store;
    } catch {
      return null;
    }
  }

  static async list(): Promise<SessionMeta[]> {
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
        if (meta.id === entry) metas.push(meta);
      } catch {
        // 跳过损坏的会话目录
      }
    }
    return metas.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async append(message: CoreMessage): Promise<void> {
    await fs.appendFile(this.messagesPath(), `${JSON.stringify(message)}\n`);
    const meta = await this.meta();
    meta.updatedAt = Date.now();
    if (!meta.title && message.role === "user") {
      meta.title = messageText(message).slice(0, 60);
    }
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
        // 忽略解析失败的行
      }
    }
    return messages;
  }

  async meta(): Promise<SessionMeta> {
    const raw = await fs.readFile(this.metaPath(), "utf8");
    return JSON.parse(raw) as SessionMeta;
  }

  async setTitle(title: string): Promise<void> {
    const meta = await this.meta();
    meta.title = title;
    meta.updatedAt = Date.now();
    await fs.writeFile(this.metaPath(), JSON.stringify(meta, null, 2));
  }
}
