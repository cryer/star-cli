import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gitTreesDir } from "../src/config/paths";
import {
  diffTreeNames,
  isGitAvailable,
  restoreTree,
  trackTree,
  treeRepoDir,
} from "../src/snapshot/git-tree";

let home: string;
let dir: string;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "star-gt-home-"));
  dir = mkdtempSync(path.join(os.tmpdir(), "star-gt-"));
  vi.stubEnv("STAR_HOME", home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("treeRepoDir", () => {
  it("is STAR_HOME-scoped and unique per working directory", () => {
    expect(treeRepoDir(dir).startsWith(gitTreesDir())).toBe(true);
    expect(treeRepoDir(dir)).toBe(treeRepoDir(dir));
    expect(treeRepoDir(dir)).not.toBe(treeRepoDir(home));
  });
});

describe("trackTree / restoreTree", () => {
  it("restores modified, created, and deleted files", async () => {
    writeFileSync(path.join(dir, "keep.txt"), "v1");
    writeFileSync(path.join(dir, "gone.txt"), "to delete");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;

    writeFileSync(path.join(dir, "keep.txt"), "v2");
    writeFileSync(path.join(dir, "fresh.txt"), "new");
    rmSync(path.join(dir, "gone.txt"));

    expect(await restoreTree(dir, tree)).toBe(true);
    expect(readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("v1");
    expect(existsSync(path.join(dir, "fresh.txt"))).toBe(false);
    expect(readFileSync(path.join(dir, "gone.txt"), "utf8")).toBe("to delete");
  });

  it("recaptures an unchanged tree identically", async () => {
    writeFileSync(path.join(dir, "a.txt"), "same");
    const first = await trackTree(dir);
    const second = await trackTree(dir);
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("keeps .gitignore'd files out of the tree and untouched by a restore", async () => {
    writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n");
    writeFileSync(path.join(dir, "tracked.txt"), "v1");
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg.js"), "dep");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;

    writeFileSync(path.join(dir, "tracked.txt"), "v2");
    writeFileSync(path.join(dir, "node_modules", "pkg.js"), "dep-changed");
    writeFileSync(path.join(dir, "node_modules", "new-dep.js"), "new dep");

    expect(await restoreTree(dir, tree)).toBe(true);
    expect(readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("v1");
    // ignored files were never tracked and are not cleaned
    expect(readFileSync(path.join(dir, "node_modules", "pkg.js"), "utf8")).toBe("dep-changed");
    expect(existsSync(path.join(dir, "node_modules", "new-dep.js"))).toBe(true);
  });

  it("restores into a directory that is a real git repo without touching its .git", async () => {
    mkdirSync(path.join(dir, ".git"));
    writeFileSync(path.join(dir, ".git", "marker"), "user repo");
    writeFileSync(path.join(dir, "src.txt"), "v1");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;

    writeFileSync(path.join(dir, "src.txt"), "v2");
    expect(await restoreTree(dir, tree)).toBe(true);
    expect(readFileSync(path.join(dir, "src.txt"), "utf8")).toBe("v1");
    expect(readFileSync(path.join(dir, ".git", "marker"), "utf8")).toBe("user repo");
  });

  it("refuses to track the home directory or a filesystem root", async () => {
    expect(await trackTree(os.homedir())).toBeNull();
    expect(await trackTree(path.parse(path.resolve(dir)).root)).toBeNull();
  });

  it("restoreTree returns false for a directory that was never tracked", async () => {
    const other = mkdtempSync(path.join(os.tmpdir(), "star-gt-other-"));
    try {
      expect(await restoreTree(other, "0".repeat(40))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("diffTreeNames", () => {
  it("lists tracked changes and untracked files, read-only", async () => {
    writeFileSync(path.join(dir, "a.txt"), "1");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;

    writeFileSync(path.join(dir, "a.txt"), "2");
    writeFileSync(path.join(dir, "b.txt"), "new");

    const names = await diffTreeNames(dir, tree);
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
    // read-only: the working tree is untouched
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("2");
    expect(existsSync(path.join(dir, "b.txt"))).toBe(true);
  });

  it("returns an empty list when the tree matches the working tree", async () => {
    writeFileSync(path.join(dir, "a.txt"), "1");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;
    expect(await diffTreeNames(dir, tree)).toEqual([]);
  });
});

describe("isGitAvailable", () => {
  it("probes git once and caches the result", async () => {
    expect(await isGitAvailable()).toBe(true);
    expect(await isGitAvailable()).toBe(true);
  });
});
