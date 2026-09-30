import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function repoFiles(repoDir: string, workTree: string): string[] {
  const out = git([`--git-dir=${repoDir}`, `--work-tree=${workTree}`, "ls-files"]);
  return out === "" ? [] : out.split("\n").sort();
}

// Seeds the internal repo the way pre-exclusion star did: no info/exclude,
// so likely-secret files were tracked into the tree.
function seedPreExclusionRepo(): string {
  const repoDir = treeRepoDir(dir);
  mkdirSync(repoDir, { recursive: true });
  git(["init", "--bare", repoDir]);
  git([`--git-dir=${repoDir}`, `--work-tree=${dir}`, "add", "-A"]);
  return git([`--git-dir=${repoDir}`, `--work-tree=${dir}`, "write-tree"]);
}

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

describe("sensitive file exclusion", () => {
  it("keeps likely-secret files out of the tree and untouched by a restore", async () => {
    writeFileSync(path.join(dir, ".env"), "SECRET=one");
    writeFileSync(path.join(dir, ".env.local"), "LOCAL=1");
    writeFileSync(path.join(dir, "id_rsa"), "PRIVATE KEY");
    writeFileSync(path.join(dir, "cert.pem"), "PEM");
    writeFileSync(path.join(dir, ".env.example"), "TEMPLATE=");
    writeFileSync(path.join(dir, "tracked.txt"), "v1");
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    if (!tree) return;

    // excluded secrets never enter the index; templates stay trackable
    expect(repoFiles(treeRepoDir(dir), dir)).toEqual([".env.example", "tracked.txt"]);

    writeFileSync(path.join(dir, ".env"), "SECRET=rotated");
    writeFileSync(path.join(dir, ".env.local"), "LOCAL=2");
    writeFileSync(path.join(dir, "fresh.key"), "NEW KEY");
    writeFileSync(path.join(dir, "tracked.txt"), "v2");
    writeFileSync(path.join(dir, ".env.example"), "TEMPLATE=v2");

    expect(await restoreTree(dir, tree)).toBe(true);
    // checkout-index -a only writes index contents, and clean -fd skips
    // ignored files: the rotated secrets survive the restore byte-for-byte
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe("SECRET=rotated");
    expect(readFileSync(path.join(dir, ".env.local"), "utf8")).toBe("LOCAL=2");
    expect(existsSync(path.join(dir, "fresh.key"))).toBe(true);
    // ordinary files still restore, templates included
    expect(readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("v1");
    expect(readFileSync(path.join(dir, ".env.example"), "utf8")).toBe("TEMPLATE=");
  });

  it("untracks secrets committed before the exclusion and never restores them", async () => {
    writeFileSync(path.join(dir, ".env"), "SECRET=old");
    writeFileSync(path.join(dir, "tracked.txt"), "v1");
    const oldTree = seedPreExclusionRepo();
    expect(repoFiles(treeRepoDir(dir), dir)).toContain(".env");

    // the first track under the new rules scrubs the already-tracked secrets
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    expect(repoFiles(treeRepoDir(dir), dir)).toEqual(["tracked.txt"]);

    // the preview stays honest about what a restore would touch
    writeFileSync(path.join(dir, ".env"), "SECRET=rotated");
    writeFileSync(path.join(dir, ".env.production"), "NEW=1");
    writeFileSync(path.join(dir, "tracked.txt"), "v2");
    const names = await diffTreeNames(dir, oldTree);
    expect(names).toContain("tracked.txt");
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".env.production");

    // restoring the pre-exclusion tree must not overwrite the rotated secret
    expect(await restoreTree(dir, oldTree)).toBe(true);
    expect(readFileSync(path.join(dir, ".env"), "utf8")).toBe("SECRET=rotated");
    expect(readFileSync(path.join(dir, ".env.production"), "utf8")).toBe("NEW=1");
    expect(readFileSync(path.join(dir, "tracked.txt"), "utf8")).toBe("v1");
  });

  it("creates the git-trees root directory owner-only", async () => {
    const tree = await trackTree(dir);
    expect(tree).not.toBeNull();
    const root = gitTreesDir();
    expect(existsSync(root)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(root).mode & 0o777).toBe(0o700);
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
