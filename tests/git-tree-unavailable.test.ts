import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every git invocation fails, simulating a machine without git: the whole
// feature must degrade to null/false instead of throwing.
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    execFile: (...args: unknown[]) => {
      const callback = args[args.length - 1] as (error: Error) => void;
      callback(new Error("git is not installed"));
    },
  };
});

const { diffTreeNames, isGitAvailable, restoreTree, trackTree } = await import(
  "../src/snapshot/git-tree"
);

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "star-gt-no-home-"));
  dir = mkdtempSync(path.join(os.tmpdir(), "star-gt-no-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("git-tree without git", () => {
  it("degrades every operation to null/false", async () => {
    expect(await isGitAvailable()).toBe(false);
    expect(await trackTree(dir)).toBeNull();
    expect(await restoreTree(dir, "0".repeat(40))).toBe(false);
    expect(await diffTreeNames(dir, "0".repeat(40))).toBeNull();
  });
});
