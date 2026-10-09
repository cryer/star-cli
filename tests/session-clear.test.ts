import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTreesDir, sessionsDir } from "../src/config/paths";
import { clearSessions, deleteSession } from "../src/session/clear";
import { SessionStore } from "../src/session/store";
import { treeRepoDir } from "../src/snapshot/git-tree";
import { rmWithRetry } from "./test-fs";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-session-clear-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rmWithRetry(home);
});

async function makeSession(cwd: string): Promise<SessionStore> {
  const store = await SessionStore.create(cwd, "m");
  await store.append({ role: "user", content: "hi" });
  return store;
}

describe("clearSessions", () => {
  it("deletes only the sessions recorded for the given cwd", async () => {
    const here = await makeSession("/work/here");
    const hereToo = await makeSession("/work/here");
    const there = await makeSession("/work/there");

    const removed = await clearSessions("/work/here");

    expect(removed).toBe(2);
    expect(fs.existsSync(here.dir)).toBe(false);
    expect(fs.existsSync(hereToo.dir)).toBe(false);
    expect(fs.existsSync(there.dir)).toBe(true);
  });

  it("deletes every session directory when no cwd is given", async () => {
    const a = await makeSession("/work/a");
    const b = await makeSession("/work/b");
    // A directory whose meta.json is unreadable has no cwd to match; the
    // all-scope wipe still removes it.
    const broken = path.join(sessionsDir(), "broken");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "meta.json"), "{not json");

    const removed = await clearSessions();

    expect(removed).toBe(3);
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false);
    expect(fs.existsSync(broken)).toBe(false);
  });

  it("keeps the excluded session on disk", async () => {
    const live = await makeSession("/work/here");
    const other = await makeSession("/work/here");

    const removed = await clearSessions("/work/here", live.id);

    expect(removed).toBe(1);
    expect(fs.existsSync(live.dir)).toBe(true);
    expect(fs.existsSync(other.dir)).toBe(false);
    expect((await SessionStore.list("/work/here")).map((m) => m.id)).toEqual([live.id]);
  });

  it("returns 0 when the sessions directory does not exist", async () => {
    expect(await clearSessions()).toBe(0);
    expect(await clearSessions("/work/here")).toBe(0);
  });

  it("removes the project's git-tree repo once its last session is gone", async () => {
    const here = await makeSession("/work/here");
    const there = await makeSession("/work/there");
    fs.mkdirSync(treeRepoDir("/work/here"), { recursive: true });
    fs.mkdirSync(treeRepoDir("/work/there"), { recursive: true });

    await clearSessions("/work/here");

    expect(fs.existsSync(treeRepoDir("/work/here"))).toBe(false);
    expect(fs.existsSync(treeRepoDir("/work/there"))).toBe(true);
    expect(fs.existsSync(there.dir)).toBe(true);
  });

  it("keeps the git-tree repo while the project still has the excluded live session", async () => {
    const live = await makeSession("/work/here");
    await makeSession("/work/here");
    fs.mkdirSync(treeRepoDir("/work/here"), { recursive: true });

    await clearSessions("/work/here", live.id);

    expect(fs.existsSync(treeRepoDir("/work/here"))).toBe(true);
  });

  it("prunes every orphaned git-tree repo on a full clear", async () => {
    const a = await makeSession("/work/a");
    const live = await makeSession("/work/live");
    fs.mkdirSync(treeRepoDir("/work/a"), { recursive: true });
    fs.mkdirSync(treeRepoDir("/work/live"), { recursive: true });
    fs.mkdirSync(path.join(gitTreesDir(), "stale-no-session"), { recursive: true });

    await clearSessions(undefined, live.id);

    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(treeRepoDir("/work/a"))).toBe(false);
    expect(fs.existsSync(path.join(gitTreesDir(), "stale-no-session"))).toBe(false);
    expect(fs.existsSync(treeRepoDir("/work/live"))).toBe(true);
  });
});

describe("deleteSession", () => {
  it("deletes only the named session", async () => {
    const keep = await makeSession("/work/here");
    const gone = await makeSession("/work/here");

    await deleteSession(gone.id);

    expect(fs.existsSync(gone.dir)).toBe(false);
    expect(fs.existsSync(keep.dir)).toBe(true);
    expect((await SessionStore.list("/work/here")).map((m) => m.id)).toEqual([keep.id]);
  });

  it("removes the project's git-tree repo once its last session is deleted", async () => {
    const here = await makeSession("/work/here");
    const there = await makeSession("/work/there");
    fs.mkdirSync(treeRepoDir("/work/here"), { recursive: true });
    fs.mkdirSync(treeRepoDir("/work/there"), { recursive: true });

    await deleteSession(here.id);

    expect(fs.existsSync(treeRepoDir("/work/here"))).toBe(false);
    expect(fs.existsSync(treeRepoDir("/work/there"))).toBe(true);
    expect(fs.existsSync(there.dir)).toBe(true);
  });

  it("keeps the git-tree repo while the project still has sessions", async () => {
    const gone = await makeSession("/work/here");
    await makeSession("/work/here");
    fs.mkdirSync(treeRepoDir("/work/here"), { recursive: true });

    await deleteSession(gone.id);

    expect(fs.existsSync(treeRepoDir("/work/here"))).toBe(true);
  });

  it("is a no-op for an unknown id", async () => {
    await expect(deleteSession("no-such-session")).resolves.toBeUndefined();
  });
});
