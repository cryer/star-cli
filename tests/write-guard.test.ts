import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCheckpointRecord, checkpointContentPath } from "../src/session/checkpoints";
import { editFileTool } from "../src/tools/fs/edit";
import {
  MAX_SNAPSHOT_CONTENT_BYTES,
  clearSnapshots,
  nextSnapshotId,
  pushSnapshot,
  setSnapshotHooks,
  snapshotCount,
  undoLastSnapshot,
} from "../src/tools/fs/snapshots";
import { writeFileTool } from "../src/tools/fs/write";

let dir: string;

function ctx() {
  return { cwd: dir };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "star-write-guard-"));
  clearSnapshots();
});

afterEach(() => {
  setSnapshotHooks(null);
  clearSnapshots();
  rmSync(dir, { recursive: true, force: true });
});

describe("write_file guards", () => {
  it("refuses content containing NUL bytes", async () => {
    const res = await writeFileTool.execute({ path: "bin.dat", content: "ab\0cd" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("NUL");
  });

  it("refuses content over the 5MB snapshot cap", async () => {
    const res = await writeFileTool.execute(
      { path: "huge.txt", content: "x".repeat(MAX_SNAPSHOT_CONTENT_BYTES + 1) },
      ctx(),
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("5MB");
  });

  it("still writes normal text content", async () => {
    const res = await writeFileTool.execute({ path: "ok.txt", content: "hello" }, ctx());
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("Wrote 5 bytes");
  });
});

describe("sensitive-target guards", () => {
  it("refuses raw sensitive paths at the tool level (gate-bypass proof)", async () => {
    const res = await writeFileTool.execute({ path: ".env", content: "KEY=x" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain("sensitive");
    const edit = await editFileTool.execute(
      { path: ".npmrc", old_string: "a", new_string: "b" },
      ctx(),
    );
    expect(edit.isError).toBe(true);
    expect(edit.content).toContain("sensitive");
  });

  it("refuses writes and edits through a junction whose target is sensitive", async () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), "star-write-link-outside-"));
    try {
      writeFileSync(path.join(outside, ".env"), "SECRET=1");
      // A junction (dir symlink) inside the cwd pointing at the outside dir:
      // the link's own name is harmless, the resolved basename is not.
      symlinkSync(outside, path.join(dir, "link"), "junction");

      const overwrite = await writeFileTool.execute({ path: "link/.env", content: "pwned" }, ctx());
      expect(overwrite.isError).toBe(true);
      expect(overwrite.content).toContain("sensitive");
      expect(readFileSync(path.join(outside, ".env"), "utf8")).toBe("SECRET=1");

      const edit = await editFileTool.execute(
        { path: "link/.env", old_string: "SECRET", new_string: "pwned" },
        ctx(),
      );
      expect(edit.isError).toBe(true);
      expect(readFileSync(path.join(outside, ".env"), "utf8")).toBe("SECRET=1");

      // Even a not-yet-existing sensitive name is caught via the resolved parent.
      const create = await writeFileTool.execute({ path: "link/id_rsa", content: "x" }, ctx());
      expect(create.isError).toBe(true);

      // A benign file through the same link still writes fine.
      const ok = await writeFileTool.execute({ path: "link/public.txt", content: "hi" }, ctx());
      expect(ok.isError).toBeUndefined();
      expect(readFileSync(path.join(outside, "public.txt"), "utf8")).toBe("hi");
    } finally {
      rmSync(path.join(dir, "link"), { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("snapshot failure handling", () => {
  it("keeps an existing file when its snapshot has no recoverable content", async () => {
    const file = path.join(dir, "unreadable.txt");
    writeFileSync(file, "original");
    await pushSnapshot({
      id: nextSnapshotId(),
      path: file,
      existed: true,
      content: null,
      captureFailed: true,
      toolName: "write_file",
      timestamp: Date.now(),
      turn: 0,
      messageIndex: -1,
    });

    expect(await undoLastSnapshot()).toContain("no longer available");
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  it("does not fail a successful write when evicted checkpoint cleanup fails", async () => {
    setSnapshotHooks({ onRemove: () => Promise.reject(new Error("disk unavailable")) });
    for (let i = 0; i < 51; i++) {
      const res = await writeFileTool.execute(
        { path: "checkpoint.txt", content: `version ${i}` },
        ctx(),
      );
      expect(res.isError).toBeUndefined();
    }
    expect(readFileSync(path.join(dir, "checkpoint.txt"), "utf8")).toBe("version 50");
    expect(snapshotCount()).toBe(50);
  });

  it("keeps undo successful and consistent when checkpoint removal fails", async () => {
    writeFileSync(path.join(dir, "undo.txt"), "old");
    await writeFileTool.execute({ path: "undo.txt", content: "new" }, ctx());
    setSnapshotHooks({ onRemove: () => Promise.reject(new Error("disk unavailable")) });

    expect(await undoLastSnapshot()).toContain("Restored");
    expect(readFileSync(path.join(dir, "undo.txt"), "utf8")).toBe("old");
    expect(snapshotCount()).toBe(0);
  });
});

describe("binary snapshot round-trip", () => {
  // PNG magic + bytes that are invalid UTF-8: a utf8 round-trip would
  // replace them with U+FFFD and corrupt the restore.
  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80, 0x61,
  ]);

  it("restores an overwritten binary file byte-exact through capture, spill and revert", async () => {
    writeFileSync(path.join(dir, "img.png"), pngBytes);
    const res = await writeFileTool.execute(
      { path: "img.png", content: "overwritten with text" },
      ctx(),
    );
    expect(res.isError).toBeUndefined();
    // pushSnapshot spilled the content to the per-process temp file, so the
    // restore reads it back from disk (not memory).
    const message = await undoLastSnapshot();
    expect(message).toContain("Restored");
    expect(readFileSync(path.join(dir, "img.png"))).toEqual(pngBytes);
  });

  it("persists Buffer checkpoint content byte-exact", async () => {
    await appendCheckpointRecord(
      dir,
      {
        id: 1,
        timestamp: Date.now(),
        path: path.join(dir, "img.png"),
        existed: true,
        toolName: "write_file",
        turn: 0,
        messageIndex: -1,
      },
      pngBytes,
    );
    expect(readFileSync(checkpointContentPath(dir, 1))).toEqual(pngBytes);
  });
});
