import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendCheckpointRecord, checkpointContentPath } from "../src/session/checkpoints";
import {
  MAX_SNAPSHOT_CONTENT_BYTES,
  clearSnapshots,
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
