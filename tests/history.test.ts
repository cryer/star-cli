import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appendHistory, loadHistory } = await import("../src/cli/history");

let home: string;
let historyFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "star-history-"));
  vi.stubEnv("STAR_HOME", home);
  historyFile = path.join(home, "history");
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("loadHistory", () => {
  it("returns [] when the history file is missing", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("returns [] when the history file is unreadable", () => {
    fs.mkdirSync(historyFile); // a directory, not a file
    expect(loadHistory()).toEqual([]);
  });

  it("loads entries in order and drops empty lines", () => {
    fs.writeFileSync(historyFile, "first\n\nsecond\n   \nthird\n");
    expect(loadHistory()).toEqual(["first", "second", "third"]);
  });

  it("returns only the last `limit` entries", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `cmd${i}`);
    fs.writeFileSync(historyFile, `${lines.join("\n")}\n`);
    expect(loadHistory(3)).toEqual(["cmd7", "cmd8", "cmd9"]);
  });
});

describe("appendHistory", () => {
  it("appends entries and creates the file", () => {
    appendHistory("hello");
    appendHistory("world");
    expect(fs.readFileSync(historyFile, "utf8")).toBe("hello\nworld\n");
  });

  it("ignores empty and whitespace-only entries", () => {
    appendHistory("");
    appendHistory("   ");
    expect(fs.existsSync(historyFile)).toBe(false);
  });

  it("sanitizes embedded newlines into spaces", () => {
    appendHistory("line one\nline two\r\nline three");
    expect(loadHistory()).toEqual(["line one line two line three"]);
  });

  it("skips consecutive duplicates", () => {
    appendHistory("same");
    appendHistory("same");
    appendHistory("other");
    appendHistory("same");
    expect(loadHistory()).toEqual(["same", "other", "same"]);
  });

  it("rewrites to the last 500 entries once the file exceeds 1000 lines", () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `cmd${i}`);
    fs.writeFileSync(historyFile, `${lines.join("\n")}\n`);
    appendHistory("new entry");
    const result = loadHistory(2000);
    expect(result).toHaveLength(500);
    expect(result[0]).toBe("cmd502");
    expect(result[499]).toBe("new entry");
  });

  it("never throws when the history directory is not writable", () => {
    fs.mkdirSync(historyFile);
    expect(() => appendHistory("boom")).not.toThrow();
  });
});
