import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadFileTool } from "../src/tools/fs/read";
import type { ToolContext } from "../src/tools/types";

describe("read_file unchanged-since-last-read dedup", () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "star-read-dedup-"));
    ctx = { cwd: dir };
    writeFileSync(path.join(dir, "a.txt"), "alpha\nbeta\ngamma");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers a repeat read of the same range with a short note", async () => {
    const tool = createReadFileTool();
    const first = await tool.execute({ path: "a.txt" }, ctx);
    expect(first.content).toContain("1\talpha");

    const second = await tool.execute({ path: "a.txt" }, ctx);
    expect(second.content).toContain("unchanged since last read");
    expect(second.content).not.toContain("alpha");
  });

  it("treats a subrange of an already-sent read as covered", async () => {
    const tool = createReadFileTool();
    await tool.execute({ path: "a.txt" }, ctx);
    const res = await tool.execute({ path: "a.txt", offset: 2, limit: 1 }, ctx);
    expect(res.content).toContain("unchanged since last read");
  });

  it("re-sends content for ranges not yet shown", async () => {
    const tool = createReadFileTool();
    await tool.execute({ path: "a.txt", offset: 1, limit: 1 }, ctx);
    const res = await tool.execute({ path: "a.txt", offset: 2, limit: 1 }, ctx);
    expect(res.content).toContain("2\tbeta");
  });

  it("re-sends content after the file changed", async () => {
    const tool = createReadFileTool();
    await tool.execute({ path: "a.txt" }, ctx);
    writeFileSync(path.join(dir, "a.txt"), "alpha\nBETA\ngamma");
    // mtime+size are the cache key; force a distinct mtime for filesystems
    // with coarse timestamp resolution.
    utimesSync(path.join(dir, "a.txt"), new Date(), new Date(Date.now() + 5000));
    const res = await tool.execute({ path: "a.txt" }, ctx);
    expect(res.content).toContain("2\tBETA");
  });

  it("forgets everything on reset (history rewrite)", async () => {
    const tool = createReadFileTool();
    await tool.execute({ path: "a.txt" }, ctx);
    tool.reset?.();
    const res = await tool.execute({ path: "a.txt" }, ctx);
    expect(res.content).toContain("1\talpha");
  });

  it("does not share the cache across tool instances", async () => {
    const parent = createReadFileTool();
    const child = createReadFileTool();
    await parent.execute({ path: "a.txt" }, ctx);
    const res = await child.execute({ path: "a.txt" }, ctx);
    expect(res.content).toContain("1\talpha");
  });
});
