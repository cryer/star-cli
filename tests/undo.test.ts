import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { editFileTool } from "../src/tools/fs/edit";
import { clearSnapshots, snapshotCount, undoLastSnapshot } from "../src/tools/fs/snapshots";
import { writeFileTool } from "../src/tools/fs/write";

let dir: string;

function ctx() {
  return { cwd: dir };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-undo-"));
  clearSnapshots();
});

afterEach(() => {
  clearSnapshots();
  rmSync(dir, { recursive: true, force: true });
});

describe("file snapshots and undo", () => {
  it("snapshots old content before write_file overwrites", async () => {
    writeFileSync(path.join(dir, "a.txt"), "old");
    const result = await writeFileTool.execute({ path: "a.txt", content: "new" }, ctx());
    expect(result.isError).toBeUndefined();
    expect(snapshotCount()).toBe(1);
    const message = await undoLastSnapshot();
    expect(message).toContain("a.txt");
    expect(readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("old");
  });

  it("deletes a newly created file on undo", async () => {
    await writeFileTool.execute({ path: "fresh.txt", content: "data" }, ctx());
    expect(existsSync(path.join(dir, "fresh.txt"))).toBe(true);
    const message = await undoLastSnapshot();
    expect(message).toContain("Deleted");
    expect(existsSync(path.join(dir, "fresh.txt"))).toBe(false);
  });

  it("snapshots content before edit_file and restores it", async () => {
    writeFileSync(path.join(dir, "b.txt"), "hello world");
    const result = await editFileTool.execute(
      { path: "b.txt", old_string: "world", new_string: "there" },
      ctx(),
    );
    expect(result.isError).toBeUndefined();
    expect(readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("hello there");
    expect(snapshotCount()).toBe(1);
    await undoLastSnapshot();
    expect(readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("hello world");
  });

  it("does not snapshot failed tool executions", async () => {
    const result = await editFileTool.execute(
      { path: "missing.txt", old_string: "x", new_string: "y" },
      ctx(),
    );
    expect(result.isError).toBe(true);
    expect(snapshotCount()).toBe(0);
  });

  it("undo only reverts the most recent change", async () => {
    writeFileSync(path.join(dir, "c.txt"), "v1");
    await writeFileTool.execute({ path: "c.txt", content: "v2" }, ctx());
    await writeFileTool.execute({ path: "c.txt", content: "v3" }, ctx());
    expect(snapshotCount()).toBe(2);
    await undoLastSnapshot();
    expect(readFileSync(path.join(dir, "c.txt"), "utf8")).toBe("v2");
    await undoLastSnapshot();
    expect(readFileSync(path.join(dir, "c.txt"), "utf8")).toBe("v1");
  });

  it("reports when there is nothing to undo", async () => {
    expect(await undoLastSnapshot()).toBe("Nothing to undo.");
  });

  it("evicts the oldest snapshot beyond the 50-entry cap", async () => {
    writeFileSync(path.join(dir, "cap.txt"), "v0");
    for (let i = 1; i <= 51; i++) {
      await writeFileTool.execute({ path: "cap.txt", content: `v${i}` }, ctx());
    }
    expect(snapshotCount()).toBe(50);
    for (let i = 51; i >= 2; i--) {
      await undoLastSnapshot();
      expect(readFileSync(path.join(dir, "cap.txt"), "utf8")).toBe(`v${i - 1}`);
    }
    // the v0 -> v1 snapshot was evicted
    expect(await undoLastSnapshot()).toBe("Nothing to undo.");
  });
});
