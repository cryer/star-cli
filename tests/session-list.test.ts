import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsDir } from "../src/config/paths";
import {
  findLatestSession,
  formatSessionEntries,
  listSessionEntries,
  resolveSessionId,
  sessionPreview,
  shortSessionId,
} from "../src/session/list";
import { SessionStore } from "../src/session/store";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-session-list-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

function bumpUpdatedAt(dir: string, updatedAt: number): void {
  const file = path.join(dir, "meta.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  meta.updatedAt = updatedAt;
  fs.writeFileSync(file, JSON.stringify(meta));
}

describe("listSessionEntries", () => {
  it("lists sessions across directories with message counts", async () => {
    const here = await SessionStore.create("/work/here", "m");
    await here.append({ role: "user", content: "hi" });
    await here.append({ role: "assistant", content: "hello" });
    const there = await SessionStore.create("/work/there", "m");
    await there.append({ role: "user", content: "hi" });

    const entries = await listSessionEntries();
    expect(entries).toHaveLength(2);
    const byId = new Map(entries.map((entry) => [entry.meta.id, entry]));
    expect(byId.get(here.id)?.messageCount).toBe(2);
    expect(byId.get(there.id)?.messageCount).toBe(1);
  });

  it("sorts by updatedAt descending", async () => {
    const first = await SessionStore.create("/a", "m");
    const second = await SessionStore.create("/b", "m");
    const third = await SessionStore.create("/c", "m");
    for (const store of [first, second, third]) {
      await store.append({ role: "user", content: "hi" });
    }
    bumpUpdatedAt(first.dir, 1000);
    bumpUpdatedAt(second.dir, 3000);
    bumpUpdatedAt(third.dir, 2000);

    const entries = await listSessionEntries();
    expect(entries.map((entry) => entry.meta.id)).toEqual([second.id, third.id, first.id]);
  });

  it("filters by cwd when given", async () => {
    const here = await SessionStore.create("/work/here", "m");
    const there = await SessionStore.create("/work/there", "m");
    await here.append({ role: "user", content: "hi" });
    await there.append({ role: "user", content: "hi" });

    const entries = await listSessionEntries("/work/here");
    expect(entries.map((entry) => entry.meta.id)).toEqual([here.id]);
  });

  it("skips sessions with a corrupt meta.json", async () => {
    const good = await SessionStore.create("/a", "m");
    await good.append({ role: "user", content: "hi" });
    fs.mkdirSync(path.join(sessionsDir(), "broken"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir(), "broken", "meta.json"), "{not json");

    const entries = await listSessionEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.meta.id).toBe(good.id);
  });

  it("counts 0 messages when messages.jsonl is missing", async () => {
    const dir = path.join(sessionsDir(), "20250101000000-ab12cd");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "20250101000000-ab12cd",
        title: "",
        model: "m",
        cwd: "/a",
        createdAt: 1,
        updatedAt: 1,
      }),
    );

    const entries = await listSessionEntries();
    expect(entries[0]?.messageCount).toBe(0);
  });
});

describe("findLatestSession", () => {
  it("returns the most recently updated session for the cwd", async () => {
    const older = await SessionStore.create("/work/here", "m");
    const newer = await SessionStore.create("/work/here", "m");
    const elsewhere = await SessionStore.create("/work/there", "m");
    for (const store of [older, newer, elsewhere]) {
      await store.append({ role: "user", content: "hi" });
    }
    bumpUpdatedAt(older.dir, 1000);
    bumpUpdatedAt(newer.dir, 2000);
    bumpUpdatedAt(elsewhere.dir, 9000);

    const latest = await findLatestSession("/work/here");
    expect(latest?.id).toBe(newer.id);
  });

  it("returns null when the cwd has no sessions", async () => {
    const store = await SessionStore.create("/work/there", "m");
    await store.append({ role: "user", content: "hi" });

    expect(await findLatestSession("/work/here")).toBeNull();
  });
});

describe("resolveSessionId", () => {
  it("resolves a full id", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hi" });

    expect(await resolveSessionId(store.id)).toBe(store.id);
  });

  it("resolves a unique short id", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hi" });

    expect(await resolveSessionId(shortSessionId(store.id))).toBe(store.id);
  });

  it("returns null for an unknown id", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hi" });

    expect(await resolveSessionId("nope00")).toBeNull();
  });

  it("returns null when a short id is ambiguous", async () => {
    for (const stamp of ["20250101000000", "20250102000000"]) {
      const dir = path.join(sessionsDir(), `${stamp}-abc123`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({
          id: `${stamp}-abc123`,
          title: "",
          model: "m",
          cwd: "/a",
          createdAt: 1,
          updatedAt: 1,
        }),
      );
    }

    expect(await resolveSessionId("abc123")).toBeNull();
  });
});

describe("sessionPreview", () => {
  it("returns the first user message text, whitespace-collapsed", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "system", content: "sys" });
    await store.append({ role: "user", content: "  first\n  message\n\nwith lines  " });
    await store.append({ role: "user", content: "second" });

    expect(await sessionPreview(store.id)).toBe("first message with lines");
  });

  it("joins the text parts of a multipart user message", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({
      role: "user",
      content: [
        { type: "text", text: "part one" },
        { type: "text", text: "part two" },
      ],
    });

    expect(await sessionPreview(store.id)).toBe("part one part two");
  });

  it("returns null when the session is missing or has no user text", async () => {
    expect(await sessionPreview("no-such-session")).toBeNull();

    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "assistant", content: "only assistant" });
    expect(await sessionPreview(store.id)).toBeNull();
  });

  it("skips a first line cut off at the read boundary", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "x".repeat(3000) });
    await store.append({ role: "assistant", content: "reply" });

    // A tiny budget cuts the huge first line mid-way; the partial line is
    // skipped and no other user text follows within the budget.
    expect(await sessionPreview(store.id, 128)).toBeNull();
    const preview = await sessionPreview(store.id, 8192);
    expect(preview).toHaveLength(3000);
  });
});

describe("formatSessionEntries", () => {
  it("renders short id, title, message count and relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T12:00:00"));
    const entries = [
      {
        meta: {
          id: "20250601110000-ab12cd",
          title: "调试会话",
          model: "m",
          cwd: "/a",
          createdAt: Date.now() - 3_600_000,
          updatedAt: Date.now() - 3_600_000,
        },
        messageCount: 4,
      },
      {
        meta: {
          id: "20250601000000-ef34gh",
          title: "",
          model: "m",
          cwd: "/b",
          createdAt: Date.now() - 86_400_000,
          updatedAt: Date.now() - 2 * 86_400_000,
        },
        messageCount: 0,
      },
    ];

    expect(formatSessionEntries(entries)).toBe(
      "ab12cd  调试会话  4 messages  updated 1h ago\n" + "ef34gh  (untitled)  0 messages  updated 2d ago",
    );
    vi.useRealTimers();
  });

  it("appends the session directory when showCwd is set", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-06-01T12:00:00"));
    const entries = [
      {
        meta: {
          id: "20250601110000-ab12cd",
          title: "跨目录",
          model: "m",
          cwd: "/work/other",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        messageCount: 1,
      },
    ];

    expect(formatSessionEntries(entries, { showCwd: true })).toBe(
      "ab12cd  跨目录  1 messages  updated just now  [/work/other]",
    );
    vi.useRealTimers();
  });
});
