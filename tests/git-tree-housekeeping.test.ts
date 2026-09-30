import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocked git: every invocation succeeds and is recorded, write-tree returns a
// stable hash. failOn simulates a failing subcommand. This keeps the gc and
// failure-cache tests fast and deterministic (no 50 real git spawns).
const calls: string[][] = [];
let failOn: ((args: string[]) => boolean) | null = null;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (...args: unknown[]) => {
      const argv = args[1] as string[];
      const callback = args[args.length - 1] as (error: Error | null, stdout: string) => void;
      calls.push(argv);
      if (failOn?.(argv)) {
        callback(new Error("git failed"), "");
        return;
      }
      if (argv.includes("write-tree")) {
        callback(null, `${"f".repeat(40)}\n`);
        return;
      }
      callback(null, "");
    },
  };
});

const { resetGitTreeCaches, trackTree } = await import("../src/snapshot/git-tree");

let home: string;
let dir: string;

function countCalls(subcommand: string): number {
  return calls.filter((argv) => argv.includes(subcommand)).length;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "star-gt-hk-home-"));
  dir = mkdtempSync(path.join(os.tmpdir(), "star-gt-hk-"));
  vi.stubEnv("STAR_HOME", home);
  calls.length = 0;
  failOn = null;
  resetGitTreeCaches();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("periodic gc", () => {
  it("runs git gc --auto after every 50 successful captures", async () => {
    for (let i = 0; i < 50; i++) {
      expect(await trackTree(dir)).not.toBeNull();
    }
    expect(countCalls("gc")).toBe(1);

    for (let i = 0; i < 50; i++) {
      expect(await trackTree(dir)).not.toBeNull();
    }
    expect(countCalls("gc")).toBe(2);
  });

  it("ignores a gc failure — the capture still succeeds", async () => {
    failOn = (argv) => argv.includes("gc");
    for (let i = 0; i < 50; i++) {
      expect(await trackTree(dir)).not.toBeNull();
    }
    expect(countCalls("gc")).toBe(1);
    // a failed gc must not trip the failure negative cache either
    expect(await trackTree(dir)).not.toBeNull();
  });
});

describe("trackTree failure negative cache", () => {
  it("stops retrying a failing directory until the TTL passes", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    failOn = (argv) => argv.includes("add");

    expect(await trackTree(dir)).toBeNull();
    const callsAfterFailure = calls.length;
    expect(callsAfterFailure).toBeGreaterThan(0);

    // within the TTL the failure is replayed from cache: no git spawned
    now.mockReturnValue(1_000_000 + 60_000);
    expect(await trackTree(dir)).toBeNull();
    expect(calls.length).toBe(callsAfterFailure);

    // past the TTL the directory is retried
    now.mockReturnValue(1_000_000 + 6 * 60_000);
    expect(await trackTree(dir)).toBeNull();
    expect(calls.length).toBeGreaterThan(callsAfterFailure);
  });

  it("recovers on the post-TTL retry and tracks normally again", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000_000);
    failOn = (argv) => argv.includes("add");
    expect(await trackTree(dir)).toBeNull();

    now.mockReturnValue(1_000_000 + 6 * 60_000);
    failOn = null;
    expect(await trackTree(dir)).not.toBeNull();

    // the cache was cleared: the very next capture really invokes git
    const callsBefore = calls.length;
    expect(await trackTree(dir)).not.toBeNull();
    expect(calls.length).toBeGreaterThan(callsBefore);
  });

  it("never spawns git for guarded directories, cache or not", async () => {
    expect(await trackTree(os.homedir())).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
