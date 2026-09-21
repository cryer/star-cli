import path from "node:path";
import type { FileSnapshot } from "../../tools/fs/snapshots";

export interface RewindPlan {
  target: FileSnapshot;
  affected: FileSnapshot[];
  // Smallest conversation message index among affected snapshots; null when
  // none carries turn context (then a rewind reverts files only).
  messageIndex: number | null;
}

// Selects the snapshots a rewind to just before checkpoint `id` would revert:
// the target itself and everything after it.
export function planRewind(snapshots: FileSnapshot[], id: number): RewindPlan | null {
  const target = snapshots.find((snapshot) => snapshot.id === id);
  if (!target) return null;
  const affected = snapshots.filter((snapshot) => snapshot.id >= id);
  let messageIndex: number | null = null;
  for (const snapshot of affected) {
    if (snapshot.messageIndex >= 0) {
      messageIndex =
        messageIndex === null
          ? snapshot.messageIndex
          : Math.min(messageIndex, snapshot.messageIndex);
    }
  }
  return { target, affected, messageIndex };
}

function displayPath(filePath: string, cwd: string): string {
  const relative = path.relative(cwd, filePath);
  return relative !== "" && !relative.startsWith("..") ? relative : filePath;
}

function formatTime(timestamp: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatCheckpointList(snapshots: FileSnapshot[], cwd: string): string {
  if (snapshots.length === 0) {
    return "No checkpoints yet — checkpoints are recorded on every successful write_file/edit_file.";
  }
  const lines = snapshots.map((snapshot) => {
    const label = snapshot.existed ? snapshot.toolName : `${snapshot.toolName} (new file)`;
    return `#${snapshot.id}  ${formatTime(snapshot.timestamp)}  ${label}  ${displayPath(snapshot.path, cwd)}`;
  });
  return [
    `Checkpoints (${snapshots.length}):`,
    ...lines,
    "Use /rewind <n> to restore files and conversation to just before checkpoint n.",
  ].join("\n");
}
