import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_DIR_MENTION_ENTRIES,
  MAX_IMAGE_BYTES,
  MAX_MENTION_BYTES,
  parseMentions,
  resolveMentions,
} from "../src/cli/mentions";

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

  it("extracts directory mentions with a trailing slash", () => {
    const { cleanText, mentions } = parseMentions("look at @src/agent/ please");
    expect(mentions).toEqual(["src/agent/"]);
    expect(cleanText).toBe("look at  please");
  });
});

describe("resolveMentions", () => {
  it("returns input unchanged when there are no mentions", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("hello world", dir);
    expect(resolved).toEqual({ input: "hello world", attached: [], skipped: [], images: [] });
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

  it("inlines a directory as a tree listing", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "sub", "nested"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "b.txt"), "b");
    writeFileSync(path.join(dir, "sub", "a.txt"), "a");
    writeFileSync(path.join(dir, "sub", "nested", "c.txt"), "c");
    const resolved = await resolveMentions("read @sub", dir);
    expect(resolved.attached).toEqual(["sub"]);
    expect(resolved.skipped).toEqual([]);
    expect(resolved.input).toBe(
      [
        "read",
        "",
        "--- @sub/ (directory) ---",
        "sub/",
        "├── nested/",
        "│   └── c.txt",
        "├── a.txt",
        "└── b.txt",
        "--- end ---",
      ].join("\n"),
    );
  });

  it("inlines an empty directory", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "empty"));
    const resolved = await resolveMentions("read @empty", dir);
    expect(resolved.attached).toEqual(["empty"]);
    expect(resolved.input).toBe("read\n\n--- @empty/ (directory) ---\nempty/\n--- end ---");
  });

  it("resolves directory mentions with a trailing slash", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "a.txt"), "a");
    const resolved = await resolveMentions("read @sub/", dir);
    expect(resolved.attached).toEqual(["sub/"]);
    expect(resolved.skipped).toEqual([]);
    expect(resolved.input).toContain("--- @sub/ (directory) ---\nsub/\n└── a.txt\n--- end ---");
  });

  it("honors .starignore and sensitive files in directory listings", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".starignore"), "secret/\n*.log\n");
    mkdirSync(path.join(dir, "sub", "secret"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "secret", "hidden.txt"), "x");
    writeFileSync(path.join(dir, "sub", "debug.log"), "x");
    writeFileSync(path.join(dir, "sub", ".env"), "SECRET=1");
    writeFileSync(path.join(dir, "sub", "keep.txt"), "x");
    const resolved = await resolveMentions("read @sub", dir);
    expect(resolved.attached).toEqual(["sub"]);
    expect(resolved.input).toContain("└── keep.txt");
    expect(resolved.input).not.toContain("secret");
    expect(resolved.input).not.toContain("debug.log");
    expect(resolved.input).not.toContain(".env");
  });

  it("truncates directory listings past the entry cap", async () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "sub"));
    for (let i = 0; i < MAX_DIR_MENTION_ENTRIES + 3; i++) {
      writeFileSync(path.join(dir, "sub", `f${String(i).padStart(3, "0")}.txt`), "x");
    }
    const resolved = await resolveMentions("read @sub", dir);
    expect(resolved.attached).toEqual(["sub"]);
    expect(resolved.input).toContain("... (truncated, 3 more entries — use glob/grep tools");
    expect(resolved.input).toContain("f000.txt");
    expect(resolved.input).not.toContain("f202.txt");
  });

  it("skips missing directories with a reason", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("read @nope/", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "nope/", reason: "file not found" }]);
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

  it("attaches an image as base64 without inlining it into the text", async () => {
    const dir = tempDir();
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(path.join(dir, "pic.png"), pngBytes);
    const resolved = await resolveMentions("describe @pic.png", dir);
    expect(resolved.attached).toEqual(["pic.png"]);
    expect(resolved.skipped).toEqual([]);
    expect(resolved.images).toEqual([
      { path: "pic.png", mimeType: "image/png", data: pngBytes.toString("base64") },
    ]);
    expect(resolved.input).toBe("describe");
  });

  it("maps image extensions to mime types case-insensitively", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "photo.JPEG"), Buffer.from([0xff, 0xd8]));
    const resolved = await resolveMentions("see @photo.JPEG", dir);
    expect(resolved.images).toHaveLength(1);
    expect(resolved.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("skips images over the image size limit", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const resolved = await resolveMentions("look @huge.png", dir);
    expect(resolved.attached).toEqual([]);
    expect(resolved.images).toEqual([]);
    expect(resolved.skipped).toEqual([{ path: "huge.png", reason: "image too large" }]);
  });

  it("skips a missing image with a reason", async () => {
    const dir = tempDir();
    const resolved = await resolveMentions("look @gone.png", dir);
    expect(resolved.skipped).toEqual([{ path: "gone.png", reason: "file not found" }]);
  });
});
