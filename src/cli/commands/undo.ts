import { readFile } from "node:fs/promises";
import path from "node:path";
import { type FileSnapshot, resolveSnapshotContent } from "../../tools/fs/snapshots";
import { type DiffLine, buildDiffLines } from "../diff-preview";

export interface UndoFileDiff {
  label: string;
  lines: DiffLine[];
}

function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  return relative !== "" && !relative.startsWith("..") ? relative : filePath;
}

// Read-only preview of the file reverts a turn-scoped /undo would apply: for
// every snapshot of the retracted turn, the diff from the current on-disk
// content back to the pre-change content (all deletions for a file the turn
// created, all additions when the file has since been deleted).
export async function buildUndoDiffs(
  snapshots: FileSnapshot[],
  cwd: string,
): Promise<UndoFileDiff[]> {
  const diffs: UndoFileDiff[] = [];
  for (const snapshot of snapshots) {
    let current = "";
    try {
      current = await readFile(snapshot.path, "utf8");
    } catch {
      // file currently missing — reverting recreates it from the snapshot
    }
    const before = snapshot.existed ? await resolveSnapshotContent(snapshot) : "";
    const lines =
      before === null
        ? [{ kind: "marker" as const, text: "(snapshot content unavailable)" }]
        : buildDiffLines(current, before);
    diffs.push({ label: displayPath(snapshot.path, cwd), lines });
  }
  return diffs;
}
