import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Simulates an external writer racing edit_file: right after the tool's
// post-read stat(), the file's mtime jumps backwards, so the pre-write
// re-stat must detect the drift and refuse the edit.
let raceExternalWrite = false;
let statCalls = 0;

vi.mock("node:fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...mod,
    stat: async (...args: Parameters<typeof mod.stat>) => {
      const result = await mod.stat(...args);
      statCalls += 1;
      const target = typeof args[0] === "string" ? args[0] : "";
      if (raceExternalWrite && statCalls === 1 && target.endsWith("race.txt")) {
        const past = new Date(Date.now() - 60_000);
        await mod.utimes(target, past, past);
      }
      return result;
    },
  };
});

const { editFileTool } = await import("../src/tools/fs/edit");
const { clearSnapshots } = await import("../src/tools/fs/snapshots");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-edit-toctou-"));
  raceExternalWrite = false;
  statCalls = 0;
  clearSnapshots();
});

afterEach(() => {
  clearSnapshots();
  rmSync(dir, { recursive: true, force: true });
});

describe("edit_file TOCTOU guard", () => {
  it("refuses to overwrite a file that changed between read and write", async () => {
    writeFileSync(path.join(dir, "race.txt"), "v1");
    raceExternalWrite = true;
    const res = await editFileTool.execute(
      { path: "race.txt", old_string: "v1", new_string: "v2" },
      { cwd: dir },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("file changed since it was read");
    expect(readFileSync(path.join(dir, "race.txt"), "utf8")).toBe("v1");
  });

  it("edits normally when the file is untouched", async () => {
    writeFileSync(path.join(dir, "race.txt"), "v1");
    const res = await editFileTool.execute(
      { path: "race.txt", old_string: "v1", new_string: "v2" },
      { cwd: dir },
    );
    expect(res.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "race.txt"), "utf8")).toBe("v2");
  });
});
