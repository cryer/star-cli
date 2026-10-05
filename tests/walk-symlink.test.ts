import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDefaultRegistry } from "../src/tools";
import { walkFiles } from "../src/tools/fs/util";
import type { ToolContext, ToolResult } from "../src/tools/types";

// Windows: directory symlinks and file symlinks need admin or developer mode
// (EPERM here), but directory junctions need neither and report
// Dirent.isSymbolicLink() === true, exercising the same walk code path. Probe
// both once and skip what the platform cannot create.
function probeLink(kind: "junction" | "file"): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "star-linkprobe-"));
  try {
    if (kind === "junction") {
      fs.mkdirSync(path.join(probe, "target"));
      fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "junction");
    } else {
      fs.writeFileSync(path.join(probe, "target.txt"), "x");
      fs.symlinkSync(path.join(probe, "target.txt"), path.join(probe, "link.txt"), "file");
    }
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const JUNCTIONS_OK = probeLink("junction");
const FILE_LINKS_OK = probeLink("file");

let dir: string;
let ctx: ToolContext;
const registry = createDefaultRegistry();

function run(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) {
    throw new Error(`tool not registered: ${name}`);
  }
  return tool.execute(args, ctx);
}

function junction(target: string, link: string) {
  // Junction targets must be absolute; Node resolves relative ones against
  // the current process cwd, not the link's parent.
  fs.symlinkSync(path.resolve(target), link, "junction");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-walklink-"));
  ctx = { cwd: dir };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!JUNCTIONS_OK)("walk follows directory links (junctions)", () => {
  it("glob and grep find files through a linked directory", async () => {
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "inner.txt"), "needle inner");
    junction(path.join(dir, "real"), path.join(dir, "link"));

    const globbed = await run("glob", { pattern: "*.txt" });
    expect(globbed.content).toContain("real/inner.txt");
    expect(globbed.content).toContain("link/inner.txt");

    const grepped = await run("grep", { pattern: "needle" });
    expect(grepped.content).toContain("real/inner.txt:1:needle inner");
    expect(grepped.content).toContain("link/inner.txt:1:needle inner");
  });

  it("does not loop on a link cycle between two directories", async () => {
    fs.mkdirSync(path.join(dir, "a"));
    fs.mkdirSync(path.join(dir, "b"));
    fs.writeFileSync(path.join(dir, "a", "file-a.txt"), "needle a");
    fs.writeFileSync(path.join(dir, "b", "file-b.txt"), "needle b");
    junction(path.join(dir, "b"), path.join(dir, "a", "link-b"));
    junction(path.join(dir, "a"), path.join(dir, "b", "link-a"));

    const res = await run("glob", { pattern: "*.txt" });
    const lines = res.content.split("\n");
    expect(lines).toContain("a/file-a.txt");
    expect(lines).toContain("b/file-b.txt");
    // The cycle is entered at most once per realpath; no unbounded recursion
    // of link-b/link-a/link-b/... prefixes.
    expect(lines.some((l) => l.includes("link-b/link-a/link-b"))).toBe(false);
    expect(lines.length).toBeLessThanOrEqual(8);
  });

  it("does not loop on a link pointing at an ancestor directory", async () => {
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "root.txt"), "needle root");
    fs.writeFileSync(path.join(dir, "sub", "deep.txt"), "needle deep");
    junction(dir, path.join(dir, "sub", "up"));

    const res = await run("glob", { pattern: "*.txt" });
    const lines = res.content.split("\n");
    expect(lines).toContain("root.txt");
    expect(lines).toContain("sub/deep.txt");
    expect(lines.some((l) => l.startsWith("sub/up/"))).toBe(false);
  });

  it("skips links whose target resolves outside the working directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "star-outside-"));
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "needle outside");
      junction(outside, path.join(dir, "link-out"));
      fs.writeFileSync(path.join(dir, "in.txt"), "needle in");

      const globbed = await run("glob", { pattern: "*.txt" });
      expect(globbed.content).toContain("in.txt");
      expect(globbed.content).not.toContain("link-out");

      const grepped = await run("grep", { pattern: "needle" });
      expect(grepped.content).toContain("in.txt:1:needle in");
      expect(grepped.content).not.toContain("secret");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("still skips SKIP_DIRS reached through a link", async () => {
    fs.mkdirSync(path.join(dir, "vendor", "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vendor", "node_modules", "dep", "x.ts"), "needle dep");
    fs.writeFileSync(path.join(dir, "vendor", "keep.ts"), "needle keep");
    junction(path.join(dir, "vendor"), path.join(dir, "vend-link"));

    const globbed = await run("glob", { pattern: "*.ts" });
    expect(globbed.content).toContain("vend-link/keep.ts");
    expect(globbed.content).not.toContain("node_modules");

    const grepped = await run("grep", { pattern: "needle" });
    expect(grepped.content).toContain("vend-link/keep.ts:1:needle keep");
    expect(grepped.content).not.toContain("dep");
  });

  it("skips a link named like a SKIP_DIRS entry", async () => {
    fs.mkdirSync(path.join(dir, "realpkg"));
    fs.writeFileSync(path.join(dir, "realpkg", "x.ts"), "needle pkg");
    junction(path.join(dir, "realpkg"), path.join(dir, "node_modules"));

    const res = await run("glob", { pattern: "*.ts" });
    // The real directory is found normally; the link named node_modules is
    // skipped by name like a real one.
    expect(res.content).toContain("realpkg/x.ts");
    expect(res.content).not.toContain("node_modules");
  });
});

describe.skipIf(!FILE_LINKS_OK)("walk follows file symlinks", () => {
  it("grep reads a file reached through a file symlink", async () => {
    fs.writeFileSync(path.join(dir, "target.txt"), "needle target");
    fs.symlinkSync(path.join(dir, "target.txt"), path.join(dir, "alias.txt"), "file");

    const res = await run("grep", { pattern: "needle" });
    expect(res.content).toContain("target.txt:1:needle target");
    expect(res.content).toContain("alias.txt:1:needle target");
  });
});

describe("walk aborts on signal", () => {
  it("walkFiles returns immediately with a pre-aborted signal", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const controller = new AbortController();
    controller.abort();
    const res = await walkFiles(dir, undefined, { signal: controller.signal });
    expect(res.aborted).toBe(true);
    expect(res.files).toEqual([]);
  });

  it("walkFiles reports aborted: false when the signal never fires", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const controller = new AbortController();
    const res = await walkFiles(dir, undefined, {
      signal: controller.signal,
      withMtime: false,
    });
    expect(res.aborted).toBe(false);
    expect(res.files.map((f) => f.rel)).toEqual(["a.txt"]);
  });

  it("walkFiles keeps entries collected before the abort and flags truncation", async () => {
    // Plain files with withMtime:false are collected synchronously inside the
    // entry loop, so flipping `aborted` by read count deterministically stops
    // the walk after the first two entries.
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    let reads = 0;
    const signal = {
      get aborted() {
        reads += 1;
        return reads > 3;
      },
    } as unknown as AbortSignal;
    const res = await walkFiles(dir, undefined, { signal, withMtime: false });
    expect(res.aborted).toBe(true);
    expect(res.files.length).toBe(2);
  });

  it("glob annotates partial results when aborted", async () => {
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt"]) {
      fs.writeFileSync(path.join(dir, name), "x");
    }
    let reads = 0;
    ctx.abortSignal = {
      get aborted() {
        reads += 1;
        return reads > 3;
      },
    } as unknown as AbortSignal;
    const res = await run("glob", { pattern: "*.txt" });
    expect(res.content).toContain("... (interrupted: partial results)");
  });

  it("glob reports interruption when nothing was collected", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "x");
    const controller = new AbortController();
    controller.abort();
    ctx.abortSignal = controller.signal;
    const res = await run("glob", { pattern: "*.txt" });
    expect(res.content).toBe("Search interrupted before any files matched pattern: *.txt");
  });

  it("grep annotates partial matches when the abort lands mid-scan", async () => {
    // With 20 plain files the walk reads `aborted` exactly 22 times (walkDir
    // entry check + 20 entries + the final return read), so a signal flipping
    // after 23 reads lets the walk finish, lets the first 16-file chunk scan,
    // then stops the second chunk.
    for (const name of [
      "f01.txt",
      "f02.txt",
      "f03.txt",
      "f04.txt",
      "f05.txt",
      "f06.txt",
      "f07.txt",
      "f08.txt",
      "f09.txt",
      "f10.txt",
      "f11.txt",
      "f12.txt",
      "f13.txt",
      "f14.txt",
      "f15.txt",
      "f16.txt",
      "f17.txt",
      "f18.txt",
      "f19.txt",
      "f20.txt",
    ]) {
      fs.writeFileSync(path.join(dir, name), "needle");
    }
    let reads = 0;
    ctx.abortSignal = {
      get aborted() {
        reads += 1;
        return reads > 23;
      },
    } as unknown as AbortSignal;
    const res = await run("grep", { pattern: "needle" });
    const lines = res.content.split("\n");
    expect(lines.filter((l) => l.endsWith(":needle")).length).toBe(16);
    expect(lines).toContain("... (interrupted: partial results)");
  });

  it("grep reports interruption when the abort lands mid-walk", async () => {
    for (const name of ["f1.txt", "f2.txt", "f3.txt", "f4.txt"]) {
      fs.writeFileSync(path.join(dir, name), "needle");
    }
    let reads = 0;
    ctx.abortSignal = {
      get aborted() {
        reads += 1;
        return reads > 3;
      },
    } as unknown as AbortSignal;
    const res = await run("grep", { pattern: "needle" });
    expect(res.content).toBe("No matches for pattern: needle (search interrupted)");
  });

  it("grep reports interruption when nothing was collected", async () => {
    fs.writeFileSync(path.join(dir, "a.txt"), "needle");
    const controller = new AbortController();
    controller.abort();
    ctx.abortSignal = controller.signal;
    const res = await run("grep", { pattern: "needle" });
    expect(res.content).toBe("No matches for pattern: needle (search interrupted)");
  });
});
