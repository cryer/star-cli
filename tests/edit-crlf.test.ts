import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool } from "../src/tools/fs/edit";
import { clearSnapshots } from "../src/tools/fs/snapshots";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-edit-crlf-"));
  clearSnapshots();
});

afterEach(() => {
  clearSnapshots();
  rmSync(dir, { recursive: true, force: true });
});

function edit(
  file: string,
  old_string: string,
  new_string: string,
  replace_all?: boolean,
): ReturnType<typeof editFileTool.execute> {
  return editFileTool.execute({ path: file, old_string, new_string, replace_all }, { cwd: dir });
}

describe("edit_file CRLF tolerance", () => {
  it("matches an LF old_string against a CRLF file and writes back CRLF", async () => {
    writeFileSync(path.join(dir, "win.txt"), "line1\r\nline2\r\nline3\r\n");
    // read_file shows this file with \n only, so the model phrases the
    // multi-line old_string with \n — it must still match.
    const res = await edit("win.txt", "line2\nline3", "changed2\nchanged3");
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "win.txt"), "utf8")).toBe(
      "line1\r\nchanged2\r\nchanged3\r\n",
    );
  });

  it("matches a single-line LF old_string in a CRLF file", async () => {
    writeFileSync(path.join(dir, "one.txt"), "alpha\r\nbeta\r\n");
    const res = await edit("one.txt", "beta", "gamma");
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "one.txt"), "utf8")).toBe("alpha\r\ngamma\r\n");
  });

  it("keeps an exact CRLF old_string working (exact path wins)", async () => {
    writeFileSync(path.join(dir, "exact.txt"), "a\r\nb\r\n");
    const res = await edit("exact.txt", "a\r\nb", "x\r\ny");
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "exact.txt"), "utf8")).toBe("x\r\ny\r\n");
  });

  it("leaves LF files untouched end to end", async () => {
    writeFileSync(path.join(dir, "unix.txt"), "one\ntwo\nthree\n");
    const res = await edit("unix.txt", "two\nthree", "2\n3");
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "unix.txt"), "utf8")).toBe("one\n2\n3\n");
  });

  it("writes LF back when the original file is dominantly LF", async () => {
    // One stray CRLF in an LF file: an LF old_string never matches the raw
    // bytes exactly, the normalized space matches, and the write-back
    // follows the dominant LF ending (the stray CRLF is unified away).
    writeFileSync(path.join(dir, "mixed.txt"), "a\r\nb\nc\n");
    const res = await edit("mixed.txt", "a\nb", "A\nB");
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "mixed.txt"), "utf8")).toBe("A\nB\nc\n");
  });

  it("still errors on ambiguous matches in the normalized space", async () => {
    writeFileSync(path.join(dir, "dup.txt"), "same\r\nlines\r\nsame\r\nlines\r\n");
    const res = await edit("dup.txt", "same\nlines", "other");
    expect(res.isError).toBe(true);
    expect(res.content).toContain("2 locations");
    expect(readFileSync(path.join(dir, "dup.txt"), "utf8")).toBe(
      "same\r\nlines\r\nsame\r\nlines\r\n",
    );
  });

  it("replace_all replaces every normalized match and keeps CRLF", async () => {
    writeFileSync(path.join(dir, "all.txt"), "x\r\ny\r\nx\r\ny\r\n");
    const res = await edit("all.txt", "x\ny", "z", true);
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("2 replacements");
    expect(readFileSync(path.join(dir, "all.txt"), "utf8")).toBe("z\r\nz\r\n");
  });

  it("still reports not found when neither space matches", async () => {
    writeFileSync(path.join(dir, "miss.txt"), "a\r\nb\r\n");
    const res = await edit("miss.txt", "gone", "x");
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not found");
  });
});
