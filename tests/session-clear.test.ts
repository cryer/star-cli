import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionsDir } from "../src/config/paths";
import { clearSessions } from "../src/session/clear";
import { SessionStore } from "../src/session/store";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-session-clear-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
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
});
