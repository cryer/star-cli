import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestPaths } from "../src/cli/path-suggest";
import { createDefaultRegistry } from "../src/tools";
import { SKIP_DIRS, walkFiles } from "../src/tools/fs/util";
import type { ToolContext, ToolResult } from "../src/tools/types";

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

function write(rel: string, body: string) {
  const abs = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

function probeJunction(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "star-jprobe-"));
  try {
    fs.mkdirSync(path.join(probe, "target"));
    fs.symlinkSync(path.join(probe, "target"), path.join(probe, "link"), "junction");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

const JUNCTIONS_OK = probeJunction();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-nestedignore-"));
  ctx = { cwd: dir };
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("nested .starignore", () => {
  beforeEach(() => {
    write("top.txt", "needle top");
    write("a/.starignore", "# nested rules\nsecret/\n*.log\n");
    write("a/keep.ts", "needle keep-a");
    write("a/debug.log", "needle log-a");
    write("a/secret/x.txt", "needle secret-a");
    write("b/keep.ts", "needle keep-b");
    write("b/debug.log", "needle log-b");
    write("b/secret/y.txt", "needle secret-b");
  });

  it("glob applies nested rules to that directory's subtree only", async () => {
    const res = await run("glob", { pattern: "*" });
    const lines = res.content.split("\n");
    expect(lines).toContain("top.txt");
    expect(lines).toContain("a/keep.ts");
    expect(lines).not.toContain("a/debug.log");
    expect(lines.some((l) => l.startsWith("a/secret/"))).toBe(false);
    // Rules anchored at a/ must not leak into the sibling b/.
    expect(lines).toContain("b/debug.log");
    expect(lines).toContain("b/secret/y.txt");
  });

  it("grep applies nested rules to that directory's subtree only", async () => {
    const res = await run("grep", { pattern: "needle" });
    const lines = res.content.split("\n");
    expect(lines.some((l) => l.startsWith("a/keep.ts:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("a/debug.log:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("a/secret/"))).toBe(false);
    expect(lines.some((l) => l.startsWith("b/debug.log:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("b/secret/y.txt:"))).toBe(true);
  });

  it("nested rules match paths relative to their own directory", async () => {
    write("a/sub/deep.txt", "needle deep");
    write("b/sub/deep.txt", "needle deep-b");
    fs.writeFileSync(path.join(dir, "a", ".starignore"), "sub/deep.txt\n");

    const res = await run("glob", { pattern: "*.txt" });
    expect(res.content).not.toContain("a/sub/deep.txt");
    expect(res.content).toContain("b/sub/deep.txt");
  });

  it("combines with the root .starignore, which keeps its old behavior", async () => {
    write("root.md", "needle md-root");
    write("a/nested.md", "needle md-a");
    fs.writeFileSync(path.join(dir, ".starignore"), "*.md\n");

    const res = await run("glob", { pattern: "*" });
    const lines = res.content.split("\n");
    expect(lines).toContain("a/keep.ts");
    expect(lines).not.toContain("root.md");
    expect(lines).not.toContain("a/nested.md");
    expect(lines).not.toContain("a/debug.log");
  });

  it("applies nested rules when globbing a subdirectory directly", async () => {
    const res = await run("glob", { pattern: "*", path: "a" });
    expect(res.content).toContain("keep.ts");
    expect(res.content).not.toContain("debug.log");
    expect(res.content).not.toContain("secret/");
  });

  it("picks up a deeper .starignore below an otherwise unignored tree", async () => {
    write("a/sub/.starignore", "hidden.txt\n");
    write("a/sub/hidden.txt", "needle hidden");
    write("a/sub/shown.txt", "needle shown");

    const res = await run("glob", { pattern: "*.txt" });
    expect(res.content).not.toContain("a/sub/hidden.txt");
    expect(res.content).toContain("a/sub/shown.txt");
  });

  it.skipIf(!JUNCTIONS_OK)("applies .starignore found inside a linked subtree", async () => {
    write("realsub/.starignore", "hidden.txt\n");
    write("realsub/hidden.txt", "needle hidden");
    write("realsub/shown.txt", "needle shown");
    fs.symlinkSync(path.resolve(dir, "realsub"), path.join(dir, "link"), "junction");

    const res = await run("glob", { pattern: "*.txt" });
    const lines = res.content.split("\n");
    expect(lines).toContain("realsub/shown.txt");
    expect(lines).toContain("link/shown.txt");
    expect(lines).not.toContain("realsub/hidden.txt");
    expect(lines).not.toContain("link/hidden.txt");
  });
});

describe("SKIP_DIRS single source", () => {
  it("glob, grep, walkFiles and path-suggest all skip exactly the shared set", async () => {
    for (const name of SKIP_DIRS) {
      write(`${name}/pkg/x.ts`, "needle dep");
    }
    write("kept/x.ts", "needle keep");

    const globbed = await run("glob", { pattern: "*.ts" });
    const grepped = await run("grep", { pattern: "needle" });
    const walked = await walkFiles(dir);
    const suggested = (await suggestPaths("", dir)).map((r) => r.path);

    expect(globbed.content).toContain("kept/x.ts");
    expect(grepped.content).toContain("kept/x.ts:1:needle keep");
    expect(suggested).toContain("kept/");
    for (const name of SKIP_DIRS) {
      expect(globbed.content).not.toContain(`${name}/`);
      expect(grepped.content).not.toContain(`${name}/`);
      expect(walked.files.some((f) => f.rel.startsWith(`${name}/`))).toBe(false);
      expect(suggested).not.toContain(`${name}/`);
    }
  });

  it("walkFiles default skip set is the exported SKIP_DIRS", async () => {
    for (const name of SKIP_DIRS) {
      write(`${name}/f.txt`, "x");
    }
    const walked = await walkFiles(dir);
    expect(walked.files).toEqual([]);
  });
});
