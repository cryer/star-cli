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

  it("reads line offsets beyond the first 1MB with exact line numbers", async () => {
    const lineCount = 140_000;
    writeFileSync(
      path.join(dir, "large.txt"),
      Array.from({ length: lineCount }, (_, i) => `line-${i + 1}`).join("\n"),
    );
    const tool = createReadFileTool();
    const res = await tool.execute({ path: "large.txt", offset: 130_000, limit: 2 }, ctx);
    expect(res.content).toContain("130000\tline-130000");
    expect(res.content).toContain("130001\tline-130001");
    expect(res.content).toContain(`showing lines 130000-130001 of ${lineCount}`);
    expect(res.content).not.toContain("at least");
  });

  it("keeps binary detection and the output cap for large files", async () => {
    writeFileSync(
      path.join(dir, "binary.dat"),
      Buffer.concat([Buffer.from([0]), Buffer.alloc(1_100_000, 1)]),
    );
    const tool = createReadFileTool();
    const binary = await tool.execute({ path: "binary.dat" }, ctx);
    expect(binary.isError).toBe(true);

    writeFileSync(path.join(dir, "long-line.txt"), `${"x".repeat(1_100_000)}\ntail`);
    const capped = await tool.execute({ path: "long-line.txt" }, ctx);
    expect(capped.content.length).toBeLessThan(102 * 1024);
    expect(capped.content).toContain("output exceeds 100KB");
    expect(capped.content).toContain("of 2");
  });
});
