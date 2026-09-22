import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { suggestPaths } from "../src/cli/path-suggest";
import { createDefaultRegistry } from "../src/tools";
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

function writeIgnore(body: string) {
  const file = path.join(dir, ".starignore");
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "star-starignore-"));
  ctx = { cwd: dir };
  fs.writeFileSync(path.join(dir, "app.ts"), "needle app");
  fs.writeFileSync(path.join(dir, "debug.log"), "needle log");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "keep.ts"), "needle keep");
  fs.writeFileSync(path.join(dir, "src", "trace.log"), "needle trace");
  fs.mkdirSync(path.join(dir, "private"), { recursive: true });
  fs.writeFileSync(path.join(dir, "private", "secret.txt"), "needle secret");
  fs.mkdirSync(path.join(dir, "build", "nested"), { recursive: true });
  fs.writeFileSync(path.join(dir, "build", "out.js"), "needle build");
  fs.writeFileSync(path.join(dir, "build", "nested", "deep.js"), "needle deep");
  writeIgnore("# ignore file comment\n\n*.log\nprivate/\nbuild/**\n");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("glob with .starignore", () => {
  it("excludes ignored files and dirs", async () => {
    const res = await run("glob", { pattern: "*" });
    const lines = res.content.split("\n");
    expect(lines).toContain("app.ts");
    expect(lines).toContain("src/keep.ts");
    expect(lines).not.toContain("debug.log");
    expect(lines).not.toContain("src/trace.log");
    expect(lines.some((l) => l.startsWith("private/"))).toBe(false);
    expect(lines.some((l) => l.startsWith("build/"))).toBe(false);
  });

  it("applies the cwd .starignore when globbing a subdirectory", async () => {
    const res = await run("glob", { pattern: "*", path: "src" });
    expect(res.content).toContain("keep.ts");
    expect(res.content).not.toContain("trace.log");
  });

  it("prunes ignored directories so their files never match", async () => {
    const res = await run("glob", { pattern: "*.txt" });
    expect(res.content).toBe("No files matched pattern: *.txt");
  });

  it("picks up .starignore changes via mtime", async () => {
    const before = await run("glob", { pattern: "*.ts" });
    expect(before.content).toContain("app.ts");
    writeIgnore("# updated\n*.log\nprivate/\nbuild/**\n*.ts\n");
    const after = await run("glob", { pattern: "*.ts" });
    expect(after.content).toBe("No files matched pattern: *.ts");
  });
});

describe("grep with .starignore", () => {
  it("skips ignored files and dirs", async () => {
    const res = await run("grep", { pattern: "needle" });
    const lines = res.content.split("\n");
    expect(lines.some((l) => l.startsWith("app.ts:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("src/keep.ts:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("debug.log:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("src/trace.log:"))).toBe(false);
    expect(lines.some((l) => l.startsWith("private/"))).toBe(false);
    expect(lines.some((l) => l.startsWith("build/"))).toBe(false);
  });

  it("still searches an explicitly named ignored file", async () => {
    const res = await run("grep", { pattern: "needle", path: "debug.log" });
    expect(res.content).toContain("debug.log:1:needle log");
  });
});

describe("path-suggest with .starignore", () => {
  it("excludes ignored entries from suggestions", async () => {
    const results = await suggestPaths("", dir);
    const paths = results.map((r) => r.path);
    expect(paths).toContain("app.ts");
    expect(paths).toContain("src/");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("private/");
  });

  it("filters entries inside a matched directory prefix", async () => {
    const build = await suggestPaths("build/", dir);
    expect(build).toEqual([]);
    const src = await suggestPaths("src/", dir);
    expect(src.map((r) => r.path)).toEqual(["src/keep.ts"]);
  });
});
