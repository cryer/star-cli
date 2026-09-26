// Pure formatting behind /redo (rendering lives in the REPL, mirroring
// undo.ts/rewind.ts). A redo restores the working tree to the state captured
// just before a git-path /undo; it never touches conversation messages.

export interface RedoEntry {
  tree: string;
  label: string;
}

export interface RedoOutcome {
  ok: boolean;
  tree: string;
  label: string;
  files: number | null;
}

// Summary line for the confirm prompt: which pre-undo state comes back.
export function formatRedoSummary(entry: RedoEntry): string {
  const label = entry.label !== "" ? ` of "${entry.label}"` : "";
  return `Restore the working tree to its state before the undo${label} (tree ${entry.tree.slice(0, 8)}). Conversation messages are not restored.`;
}

export function formatRedoResult(result: RedoOutcome): string {
  if (!result.ok) {
    return `Redo failed — git could not restore the snapshot (tree ${result.tree.slice(0, 8)}). The redo entry was kept; try again or check that git is working.`;
  }
  const files = result.files === null ? "unknown number of" : `${result.files}`;
  const label = result.label !== "" ? ` — "${result.label}"` : "";
  return `Redone: restored ${files} file(s) to the pre-undo state (tree ${result.tree.slice(0, 8)})${label}.`;
}
