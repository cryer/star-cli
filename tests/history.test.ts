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

  it("keeps only the last 50 entries", () => {
    const lines = Array.from({ length: 60 }, (_, i) => `cmd${i}`);
    fs.writeFileSync(historyFile, `${lines.join("\n")}\n`);
    appendHistory("new entry");
    const result = loadHistory();
    expect(result).toHaveLength(50);
    expect(result[0]).toBe("cmd11");
    expect(result[49]).toBe("new entry");
  });

  it("trims an oversized file down to 50 entries on load", () => {
    const lines = Array.from({ length: 80 }, (_, i) => `cmd${i}`);
    fs.writeFileSync(historyFile, `${lines.join("\n")}\n`);
    const result = loadHistory();
    expect(result).toHaveLength(50);
    expect(result[0]).toBe("cmd30");
    expect(fs.readFileSync(historyFile, "utf8").trim().split("\n")).toHaveLength(50);
  });

  it("drops single-character junk lines on load and rewrites the file", () => {
    fs.writeFileSync(historyFile, `ok\n${"x".repeat(500)}\nreal command\n`);
    expect(loadHistory()).toEqual(["ok", "real command"]);
    expect(fs.readFileSync(historyFile, "utf8")).toBe("ok\nreal command\n");
  });

  it("keeps short repeated-character entries", () => {
    fs.writeFileSync(historyFile, "xxxxxxxx\n??\n");
    expect(loadHistory()).toEqual(["xxxxxxxx", "??"]);
  });

  it("ignores junk entries made of one repeated character", () => {
    appendHistory("x".repeat(1000));
    appendHistory("real command");
    expect(loadHistory()).toEqual(["real command"]);
  });

  it("never records slash commands", () => {
    appendHistory("/q");
    appendHistory("/model");
    appendHistory("real command");
    expect(loadHistory()).toEqual(["real command"]);
  });

  it("drops stored slash-command lines on load and rewrites the file", () => {
    fs.writeFileSync(historyFile, "/q\nok\n/help\n");
    expect(loadHistory()).toEqual(["ok"]);
    expect(fs.readFileSync(historyFile, "utf8")).toBe("ok\n");
  });

  it("never throws when the history directory is not writable", () => {
    fs.mkdirSync(historyFile);
    expect(() => appendHistory("boom")).not.toThrow();
  });
});
