import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MENTION_BYTES, parseMentions, resolveMentions } from "../src/cli/mentions";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "star-mentions-"));
}

describe("parseMentions", () => {
  it("extracts a mention at the start of input", () => {
    const { cleanText, mentions } = parseMentions("@src/main.ts explain this");
    expect(mentions).toEqual(["src/main.ts"]);
    expect(cleanText).toBe("explain this");
  });

  it("extracts a mention after whitespace", () => {
    const { cleanText, mentions } = parseMentions("check @src/main.ts please");
    expect(mentions).toEqual(["src/main.ts"]);
    expect(cleanText).toBe("check  please");
  });

  it("ignores emails like a@b.com", () => {
    const { cleanText, mentions } = parseMentions("mail a@b.com about it");
    expect(mentions).toEqual([]);
    expect(cleanText).toBe("mail a@b.com about it");
  });

  it("ignores a bare @ with no path chars", () => {
    const { mentions } = parseMentions("hi @ there @");
    expect(mentions).toEqual([]);
  });

  it("extracts multiple mentions and dedupes", () => {
    const { cleanText, mentions } = parseMentions("@a.ts and @b.ts and @a.ts");
    expect(mentions).toEqual(["a.ts", "b.ts"]);
    expect(cleanText).toBe("and  and");
  });

  it("supports Windows drive paths with backslashes", () => {
    const { mentions } = parseMentions(String.raw`open @C:\Users\foo\bar.txt now`);
    expect(mentions).toEqual([String.raw`C:\Users\foo\bar.txt`]);
  });

  it("supports Windows drive paths with forward slashes", () => {
    const { mentions } = parseMentions("open @C:/Users/foo/bar.txt now");
    expect(mentions).toEqual(["C:/Users/foo/bar.txt"]);
  });

  it("supports relative dot paths", () => {
    const { mentions } = parseMentions("see @./lib/util.ts and @../other.md");
    expect(mentions).toEqual(["./lib/util.ts", "../other.md"]);
  });

  it("handles mention-only input", () => {
    const { cleanText, mentions } = parseMentions("@a.ts");
    expect(mentions).toEqual(["a.ts"]);
    expect(cleanText).toBe("");
  });
});

describe("resolveMentions", () => {
  it("returns input unchanged when there are no mentions", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("hello world", dir);
    expect(resolved).toEqual({ input: "hello world", attached: [], skipped: [] });
  });

  it("injects text file content", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "note.txt"), "hello\n");
    const resolved = await resolveMentions("summarize @note.txt", dir);
    expect(resolved.attached).toEqual(["note.txt"]);
    expect(resolved.skipped).toEqual([]);
    expect(resolved.input).toBe("summarize\n\n--- @note.txt ---\nhello\n\n--- end ---");
  });

  it("skips missing files with a reason", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("read @nope.txt", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "nope.txt", reason: "file not found" }]);
    expect(resolved.input).toBe("read");
  });

  it("skips directories", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "sub"));
    const resolved = await resolveMentions("read @sub", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "sub", reason: "is a directory" }]);
  });

  it("skips binary files", async () => {
    const dir = tempDir();
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
    writeFileSync(path.join(dir, "img.bin"), buf);
    const resolved = await resolveMentions("read @img.bin", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "img.bin", reason: "binary file" }]);
  });

  it("skips files over the size limit", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "big.txt"), "x".repeat(MAX_MENTION_BYTES + 1));
    const resolved = await resolveMentions("read @big.txt", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "big.txt", reason: "exceeds 100KB limit" }]);
  });

  it("refuses .env but allows .env.example", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), "SECRET=1\n");
    writeFileSync(path.join(dir, ".env.example"), "SECRET=\n");
    const resolved = await resolveMentions("compare @.env and @.env.example", dir);
    expect(resolved.attached).toEqual([".env.example"]);
    expect(resolved.skipped).toEqual([{ path: ".env", reason: "sensitive file" }]);
    expect(resolved.input).toContain("--- @.env.example ---\nSECRET=\n\n--- end ---");
  });

  it("falls back to the original text when everything is stripped", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("@nope.txt", dir);
    expect(resolved.input).toBe("@nope.txt");
    expect(resolved.skipped).toHaveLength(1);
  });

  it("injects multiple files", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "a.ts"), "aaa");
    writeFileSync(path.join(dir, "b.ts"), "bbb");
    const resolved = await resolveMentions("@a.ts @b.ts", dir);
    expect(resolved.attached).toEqual(["a.ts", "b.ts"]);
    expect(resolved.input).toBe(
      "--- @a.ts ---\naaa\n--- end ---\n\n--- @b.ts ---\nbbb\n--- end ---",
    );
  });
});
