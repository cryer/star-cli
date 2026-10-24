import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchSessions } from "../src/session/search";
import { SessionLockedError, SessionStore } from "../src/session/store";
import { rmWithRetry } from "./test-fs";

const execFileAsync = promisify(execFile);
const storeModule = pathToFileURL(path.resolve("src/session/store.ts")).href;

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-session-lock-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rmWithRetry(home);
});

async function openInChild(id: string): Promise<string> {
  const script = `
    import { SessionStore } from ${JSON.stringify(storeModule)};
    try {
      const store = await SessionStore.open(${JSON.stringify(id)});
      if (store) await store.close();
      console.log(store ? "acquired" : "missing");
    } catch (error) {
      if (error?.code === "SESSION_LOCKED") console.log("locked");
      else throw error;
    }
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", script], {
    env: { ...process.env, STAR_HOME: home },
  });
  return stdout.trim();
}

describe("SessionStore lifecycle locking", () => {
  it("rejects another Store while allowing lock-free listing and search", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "locked needle" });

    await expect(SessionStore.open(store.id)).rejects.toBeInstanceOf(SessionLockedError);
    expect((await SessionStore.list()).map((meta) => meta.id)).toEqual([store.id]);
    expect(await searchSessions("needle")).toHaveLength(1);

    await store.close();
    await store.close();
    const reopened = await SessionStore.open(store.id);
    expect(reopened).not.toBeNull();
    await expect(store.append({ role: "user", content: "closed" })).rejects.toThrow("closed");
    await reopened?.close();
  });

  it("enforces the lock across processes and releases it on close", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hello" });

    expect(await openInChild(store.id)).toBe("locked");
    await store.close();
    expect(await openInChild(store.id)).toBe("acquired");
  });

  it("reclaims a crashed process's stale lock", async () => {
    const script = `
      import { SessionStore } from ${JSON.stringify(storeModule)};
      const store = await SessionStore.create("/child", "m");
      await store.append({ role: "user", content: "before crash" });
      process.stdout.write(store.id, () => process.exit(0));
    `;
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", "-e", script], {
      env: { ...process.env, STAR_HOME: home },
    });
    const id = stdout.trim();
    expect(fs.existsSync(path.join(home, "sessions", id, ".lock"))).toBe(true);

    const reopened = await SessionStore.open(id);
    expect(reopened).not.toBeNull();
    await expect(reopened?.append({ role: "user", content: "after crash" })).resolves.toBe(true);
    expect(await reopened?.messages()).toEqual([
      { role: "user", content: "before crash" },
      { role: "user", content: "after crash" },
    ]);
    await reopened?.close();
    expect(fs.existsSync(path.join(home, "sessions", id, ".lock"))).toBe(false);
  });

  it("sweeps only tmp files whose owning process is dead", async () => {
    const store = await SessionStore.create("/a", "m");
    await store.append({ role: "user", content: "hi" });
    await store.close();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    try {
      const active = path.join(store.dir, `meta.json.tmp-${child.pid}-active`);
      const stale = path.join(store.dir, "messages.jsonl.tmp-2147483647-0");
      fs.writeFileSync(active, "active");
      fs.writeFileSync(stale, "stale");

      const reopened = await SessionStore.open(store.id);
      expect(reopened).not.toBeNull();
      expect(fs.existsSync(active)).toBe(true);
      expect(fs.existsSync(stale)).toBe(false);
      await reopened?.close();
    } finally {
      child.kill();
    }
  });
});
