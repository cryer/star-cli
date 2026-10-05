import { appendFileSync, mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreMessage } from "../src/core/messages";
import { searchSessions } from "../src/session/search";
import { SessionStore } from "../src/session/store";
import { rmWithRetry } from "./test-fs";

describe("session search streaming", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "star-search-stream-"));
    vi.stubEnv("STAR_HOME", home);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rmWithRetry(home);
  });

  async function makeSession(cwd: string, messages: CoreMessage[]): Promise<SessionStore> {
    const store = await SessionStore.create(cwd, "test-model");
    for (const message of messages) await store.append(message);
    return store;
  }

  // Counts FileHandle.read calls per messages.jsonl path, so tests can prove
  // the scan stopped before reaching the end of a large history.
  function spyOnReads() {
    const counts = new Map<string, number>();
    const realOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const file = String(args[0]);
      if (!file.endsWith("messages.jsonl")) return handle;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === "read") {
            const read = target.read.bind(target) as unknown as (
              ...readArgs: unknown[]
            ) => Promise<unknown>;
            return (...readArgs: unknown[]) => {
              counts.set(file, (counts.get(file) ?? 0) + 1);
              return read(...readArgs);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
    });
    return counts;
  }

  it("stops reading a large history once the snippet is complete", async () => {
    const store = await makeSession(home, [{ role: "user", content: "needle right at the start" }]);
    const file = path.join(store.dir, "messages.jsonl");
    const filler = `${JSON.stringify({ role: "user", content: `filler ${"x".repeat(900)}` })}\n`;
    appendFileSync(file, filler.repeat(4000), "utf8"); // ~3.7MB behind the match
    const { size } = await fs.stat(file);
    expect(Math.ceil(size / (64 * 1024))).toBeGreaterThan(20);
    const counts = spyOnReads();

    const hits = await searchSessions("needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("needle right at the start");

    // Two streaming passes, each exiting inside the first 64KB chunk; a full
    // read would need dozens of chunk reads.
    expect(counts.get(file) ?? 0).toBeLessThanOrEqual(8);
  });

  it("stops scanning sessions once the result limit is reached", async () => {
    for (let i = 0; i < 12; i++) {
      await makeSession(home, [{ role: "user", content: `needle session ${i}` }]);
    }
    const counts = spyOnReads();

    const hits = await searchSessions("needle");
    expect(hits).toHaveLength(10);
    // Sessions past the limit were never opened at all.
    const touched = new Set([...counts.keys()].map((file) => path.basename(path.dirname(file))));
    expect(touched.size).toBeLessThanOrEqual(10);
  });

  it("reports a session once even when its matches far exceed the limit", async () => {
    const store = await makeSession(home, [
      { role: "user", content: "needle FIRST mention" },
      { role: "assistant", content: "y".repeat(500) },
    ]);
    const lines = Array.from({ length: 500 }, (_, i) =>
      JSON.stringify({ role: "user", content: `needle again ${i}` }),
    ).join("\n");
    appendFileSync(path.join(store.dir, "messages.jsonl"), `${lines}\n`, "utf8");

    const hits = await searchSessions("needle", 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.meta.id).toBe(store.id);
    // The snippet is built from the first match, not a later one.
    expect(hits[0]?.snippet).toContain("FIRST");
    expect(hits[0]?.snippet).not.toContain("again");
  });

  it("finds a needle case-insensitively inside a multibyte line spanning read chunks", async () => {
    const content = `${"汉".repeat(50_000)} needle ${"字".repeat(50_000)}`;
    await makeSession(home, [{ role: "user", content }]);

    const hits = await searchSessions("NEEDLE");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("needle");
  });

  it("matches across the message boundary like the old joined-text search", async () => {
    await makeSession(home, [
      { role: "user", content: "kuber" },
      { role: "assistant", content: "netes" },
    ]);

    const hits = await searchSessions("kuber\nnetes");
    expect(hits).toHaveLength(1);
    // The snippet collapses whitespace, so the newline joiner renders as a space.
    expect(hits[0]?.snippet).toBe("kuber netes");
  });

  it("falls back to the collapsed head when the needle contains a whitespace run", async () => {
    await makeSession(home, [
      { role: "user", content: "intro words here" },
      { role: "assistant", content: "foo  bar baz" },
    ]);

    const hits = await searchSessions("foo  bar");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toBe("intro words here foo bar baz");
  });

  it("skips sessions whose history file is missing", async () => {
    const store = await makeSession(home, [{ role: "user", content: "needle" }]);
    await fs.rm(path.join(store.dir, "messages.jsonl"));

    expect(await searchSessions("needle")).toEqual([]);
  });
});
