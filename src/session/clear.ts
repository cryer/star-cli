import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
import { pruneTreeReposExcept, removeTreeRepo } from "../snapshot/git-tree";
import { SessionStore } from "./store";

// Deletes stored sessions and returns how many were removed. With a cwd only
// sessions recorded for that directory go (directories with an unreadable
// meta.json cannot be matched and stay); without it every session directory
// under sessionsDir is removed. excludeId keeps the caller's live session on
// disk (the REPL's /clear-sessions must not pull its own store away).
//
// Snapshot cleanup rides along: per-file checkpoints live inside the session
// dir and go with it, while the per-project git-tree repos outlive sessions
// on purpose (/undo across restarts). Once a project's last session is gone
// its tree repo is unreachable, so it is removed here too — repos whose
// project still has a surviving session (e.g. the excluded live one) stay.
// Deletes a single stored session (the /resume picker's Ctrl+X). Snapshot
// cleanup matches clearSessions: once the session's project has no sessions
// left, its git-tree repo is unreachable and removed too.
export async function deleteSession(id: string): Promise<void> {
  const meta = (await SessionStore.list()).find((m) => m.id === id);
  await fs.rm(path.join(sessionsDir(), id), { recursive: true, force: true });
  if (meta && (await SessionStore.list(meta.cwd)).length === 0) {
    await removeTreeRepo(meta.cwd);
  }
}

export async function clearSessions(cwd?: string, excludeId?: string): Promise<number> {
  if (cwd !== undefined) {
    const metas = await SessionStore.list(cwd);
    let removed = 0;
    for (const meta of metas) {
      if (meta.id === excludeId) continue;
      await fs.rm(path.join(sessionsDir(), meta.id), { recursive: true, force: true });
      removed += 1;
    }
    if ((await SessionStore.list(cwd)).length === 0) {
      await removeTreeRepo(cwd);
    }
    return removed;
  }
  let entries: string[];
  try {
    entries = await fs.readdir(sessionsDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry === excludeId) continue;
    await fs.rm(path.join(sessionsDir(), entry), { recursive: true, force: true });
    removed += 1;
  }
  const survivors = await SessionStore.list();
  await pruneTreeReposExcept(survivors.map((meta) => meta.cwd));
  return removed;
}
