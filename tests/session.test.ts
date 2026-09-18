import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsDir } from "../src/config/paths";
import type { CoreMessage } from "../src/core/messages";
import { formatSessionList, resumeSession } from "../src/session/resume";
import { type SessionMeta, SessionStore } from "../src/session/store";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-session-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function readMeta(dir: string): SessionMeta {
  return JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
}

describe("SessionStore", () => {
  it("create writes nothing to disk until the first append", async () => {
    const store = await SessionStore.create("/tmp/work", "test-model");
    expect(store.dir).toBe(path.join(sessionsDir(), store.id));
    expect(fs.existsSync(store.dir)).toBe(false);

    await store.append({ role: "user", content: "你好" });
    expect(fs.existsSync(store.dir)).toBe(true);
    expect(readMeta(store.dir)).toMatchObject({
      id: store.id,
      model: "test-model",
      cwd: "/tmp/work",
    });
  });

  it("create/append/messages round-trips messages", async () => {
    const store = await SessionStore.create("/tmp/work", "test-model");

    const messages: CoreMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，有什么可以帮你？" },
      { role: "user", content: "讲讲 TypeScript" },
    ];
    for (const message of messages) await store.append(message);

    expect(await store.messages()).toEqual(messages);
  });

  it("initializes the meta title from the first user message on append", async () => {
    const store = await SessionStore.create("/tmp/work", "test-model");
    await store.append({ role: "user", content: "第一条消息" });
    expect(readMeta(store.dir).title).toBe("第一条消息");
  });

  it("writes one JSON object per line in messages.jsonl", async () => {
    const store = await SessionStore.create("/tmp/work", "test-model");
    await store.append({ role: "user", content: "第一行" });
    await store.append({ role: "assistant", content: "第二行" });

    const raw = fs.readFileSync(path.join(store.dir, "messages.jsonl"), "utf8");
    const lines = raw.split("\n").filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { role: "user", content: "第一行" },
      { role: "assistant", content: "第二行" },
    ]);
  });

  it("lists sessions sorted by updatedAt descending", async () => {
    const first = await SessionStore.create("/a", "m");
    const second = await SessionStore.create("/b", "m");
    const third = await SessionStore.create("/c", "m");
    for (const store of [first, second, third]) {
      await store.append({ role: "user", content: "hi" });
    }

    const metaPath = (dir: string) => path.join(dir, "meta.json");
    const bump = (dir: string, updatedAt: number) => {
      const meta = readMeta(dir);
      meta.updatedAt = updatedAt;
      fs.writeFileSync(metaPath(dir), JSON.stringify(meta));
    };
    bump(first.dir, 1000);
    bump(second.dir, 3000);
    bump(third.dir, 2000);

    const metas = await SessionStore.list();
    expect(metas.map((m) => m.id)).toEqual([second.id, third.id, first.id]);
  });

  it("list(cwd) filters sessions by cwd", async () => {
    const here = await SessionStore.create("/work/here", "m");
    const there = await SessionStore.create("/work/there", "m");
    await here.append({ role: "user", content: "hi" });
    await there.append({ role: "user", content: "hi" });

    const metas = await SessionStore.list("/work/here");
    expect(metas.map((m) => m.id)).toEqual([here.id]);
    expect(await SessionStore.list("/work/nowhere")).toEqual([]);
  });

  it("skips corrupt directories in list", async () => {
    const good = await SessionStore.create("/a", "m");
    await good.append({ role: "user", content: "hi" });
    fs.mkdirSync(path.join(sessionsDir(), "broken"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), "broken", "meta.json"), "{not json");

    const metas = await SessionStore.list();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.id).toBe(good.id);
  });

  it("open returns null for a missing session", async () => {
    expect(await SessionStore.open("20250101120000-nope00")).toBeNull();
    const store = await SessionStore.create("/a", "m");
    expect(await SessionStore.open(store.id)).toBeNull();
    await store.append({ role: "user", content: "hi" });
    expect((await SessionStore.open(store.id))?.id).toBe(store.id);
  });

  it("tolerates a truncated trailing line in messages.jsonl", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "完好" });
    fs.appendFileSync(path.join(store.dir, "messages.jsonl"), '{"role":"assist');

    expect(await store.messages()).toEqual([{ role: "user", content: "完好" }]);
  });

  it("sets the title from the first user message (max 60 chars)", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "assistant", content: "先说话的不是用户" });
    expect((await store.meta()).title).toBe("");

    const long = "长".repeat(80);
    await store.append({ role: "user", content: long });
    expect((await store.meta()).title).toBe("长".repeat(60));

    await store.append({ role: "user", content: "第二条用户消息不覆盖标题" });
    expect((await store.meta()).title).toBe("长".repeat(60));
  });

  it("setTitle overrides the title", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "原始标题" });
    await store.setTitle("新标题");
    expect((await store.meta()).title).toBe("新标题");
  });

  it("addUsage accumulates across calls and round-trips through open", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.addUsage({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    await store.append({ role: "user", content: "hi" });
    await store.addUsage({ promptTokens: 20, completionTokens: 7, totalTokens: 27 });

    const reopened = await SessionStore.open(store.id);
    expect((await reopened?.meta())?.usage).toEqual({
      requests: 2,
      promptTokens: 30,
      completionTokens: 12,
      totalTokens: 42,
    });
  });

  it("loads metas without a usage field", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hi" });
    const meta = readMeta(store.dir);
    meta.usage = undefined;
    fs.writeFileSync(path.join(store.dir, "meta.json"), JSON.stringify(meta));

    const reopened = await SessionStore.open(store.id);
    expect((await reopened?.meta())?.usage).toBeUndefined();

    await reopened?.addUsage({ promptTokens: 1, completionTokens: 2, totalTokens: 3 });
    expect((await reopened?.meta())?.usage).toEqual({
      requests: 1,
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
    });
  });
});

describe("resumeSession", () => {
  it("returns meta and messages for an existing session", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "恢复我" });

    const resumed = await resumeSession(store.id);
    expect(resumed?.meta.id).toBe(store.id);
    expect(resumed?.meta.title).toBe("恢复我");
    expect(resumed?.messages).toEqual([{ role: "user", content: "恢复我" }]);
  });

  it("returns null for a missing session", async () => {
    expect(await resumeSession("20250101120000-nope00")).toBeNull();
  });
});

describe("formatSessionList", () => {
  it("renders one line per session with relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T12:00:00"));
    const metas: SessionMeta[] = [
      {
        id: "20250601110000-ab12cd",
        title: "调试会话",
        model: "m",
        cwd: "/a",
        createdAt: Date.now() - 3_600_000,
        updatedAt: Date.now() - 3_600_000,
      },
      {
        id: "20250601000000-ef34gh",
        title: "",
        model: "m",
        cwd: "/b",
        createdAt: Date.now() - 86_400_000,
        updatedAt: Date.now() - 2 * 86_400_000,
      },
    ];
    const output = formatSessionList(metas);
    expect(output).toBe(
      "20250601110000-ab12cd  调试会话  (更新于 1 小时前)\n" +
        "20250601000000-ef34gh  (无标题)  (更新于 2 天前)",
    );
    vi.useRealTimers();
  });
});
