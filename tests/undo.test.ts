import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildUndoDiffs } from "../src/cli/commands/undo";
import { editFileTool } from "../src/tools/fs/edit";
import {
  beginTurn,
  clearSnapshots,
  listTurnSnapshots,
  snapshotCount,
  undoLastSnapshot,
  undoTurnSnapshots,
} from "../src/tools/fs/snapshots";
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
    expect(await undoLastSnapshot()).toContain("Nothing to undo");
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
    expect(await undoLastSnapshot()).toContain("Nothing to undo");
  });
});

describe("turn-scoped snapshots", () => {
  it("undoTurnSnapshots reverts only the given turn's changes, newest first", async () => {
    writeFileSync(path.join(dir, "t1.txt"), "a0");
    const turnOne = beginTurn();
    await writeFileTool.execute({ path: "t1.txt", content: "a1" }, ctx());
    const turnTwo = beginTurn();
    await writeFileTool.execute({ path: "t1.txt", content: "a2" }, ctx());
    await writeFileTool.execute({ path: "t2.txt", content: "new" }, ctx());

    const revertedTwo = await undoTurnSnapshots(turnTwo);
    expect(revertedTwo).toHaveLength(2);
    expect(readFileSync(path.join(dir, "t1.txt"), "utf8")).toBe("a1");
    expect(existsSync(path.join(dir, "t2.txt"))).toBe(false);

    const revertedOne = await undoTurnSnapshots(turnOne);
    expect(revertedOne).toHaveLength(1);
    expect(readFileSync(path.join(dir, "t1.txt"), "utf8")).toBe("a0");
    expect(snapshotCount()).toBe(0);
  });

  it("returns an empty list when the turn made no file changes", async () => {
    const turn = beginTurn();
    expect(await undoTurnSnapshots(turn)).toEqual([]);
  });
});

describe("undo preview (read-only)", () => {
  it("listTurnSnapshots lists a turn's snapshots newest-first without mutating the stack", async () => {
    writeFileSync(path.join(dir, "p.txt"), "v0");
    const turnOne = beginTurn();
    await writeFileTool.execute({ path: "p.txt", content: "v1" }, ctx());
    const turnTwo = beginTurn();
    await writeFileTool.execute({ path: "p.txt", content: "v2" }, ctx());
    await writeFileTool.execute({ path: "q.txt", content: "new" }, ctx());

    const listed = listTurnSnapshots(turnTwo);
    expect(listed.map((s) => path.basename(s.path))).toEqual(["q.txt", "p.txt"]);
    // read-only: the stack still holds every snapshot afterwards
    expect(snapshotCount()).toBe(3);
    expect(listTurnSnapshots(turnOne)).toHaveLength(1);
    expect(listTurnSnapshots(9999)).toEqual([]);
    expect(snapshotCount()).toBe(3);
  });

  it("buildUndoDiffs shows current content reverting to the pre-change content", async () => {
    writeFileSync(path.join(dir, "d.txt"), "line one\nline two\n");
    const turn = beginTurn();
    await editFileTool.execute(
      { path: "d.txt", old_string: "line two", new_string: "line 2" },
      ctx(),
    );

    const diffs = await buildUndoDiffs(listTurnSnapshots(turn), dir);

    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.label).toBe("d.txt");
    const del = diffs[0]?.lines.filter((l) => l.kind === "del").map((l) => l.text);
    const add = diffs[0]?.lines.filter((l) => l.kind === "add").map((l) => l.text);
    expect(del).toContain("line 2");
    expect(add).toContain("line two");
    // still read-only: the file and the snapshot stack are untouched
    expect(readFileSync(path.join(dir, "d.txt"), "utf8")).toBe("line one\nline 2\n");
    expect(snapshotCount()).toBe(1);
  });

  it("buildUndoDiffs renders a turn-created file as all deletions", async () => {
    const turn = beginTurn();
    await writeFileTool.execute({ path: "fresh.txt", content: "alpha\nbeta\n" }, ctx());

    const diffs = await buildUndoDiffs(listTurnSnapshots(turn), dir);

    expect(diffs).toHaveLength(1);
    const lines = diffs[0]?.lines ?? [];
    expect(lines.every((l) => l.kind !== "add")).toBe(true);
    expect(lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["alpha", "beta"]);
    expect(existsSync(path.join(dir, "fresh.txt"))).toBe(true);
  });

  it("buildUndoDiffs renders a since-deleted file as all additions", async () => {
    writeFileSync(path.join(dir, "gone.txt"), "old content\n");
    const turn = beginTurn();
    await editFileTool.execute(
      { path: "gone.txt", old_string: "old content", new_string: "new content" },
      ctx(),
    );
    rmSync(path.join(dir, "gone.txt"));

    const diffs = await buildUndoDiffs(listTurnSnapshots(turn), dir);

    const lines = diffs[0]?.lines ?? [];
    expect(lines.every((l) => l.kind !== "del")).toBe(true);
    expect(lines.filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["old content"]);
  });

  it("buildUndoDiffs uses the tool label for files outside the cwd", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "star-undo-outside-"));
    try {
      writeFileSync(path.join(outside, "x.txt"), "out0");
      const turn = beginTurn();
      await writeFileTool.execute({ path: path.join(outside, "x.txt"), content: "out1" }, ctx());
      const diffs = await buildUndoDiffs(listTurnSnapshots(turn), dir);
      expect(diffs[0]?.label).toBe(path.join(outside, "x.txt"));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
