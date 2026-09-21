import fs from "node:fs/promises";
import path from "node:path";
import { sessionsDir } from "../config/paths";
import { SessionStore } from "./store";

// Deletes stored sessions and returns how many were removed. With a cwd only
// sessions recorded for that directory go (directories with an unreadable
// meta.json cannot be matched and stay); without it every session directory
// under sessionsDir is removed. excludeId keeps the caller's live session on
// disk (the REPL's /clear-sessions must not pull its own store away).
export async function clearSessions(cwd?: string, excludeId?: string): Promise<number> {
  if (cwd !== undefined) {
    const metas = await SessionStore.list(cwd);
    let removed = 0;
    for (const meta of metas) {
      if (meta.id === excludeId) continue;
      await fs.rm(path.join(sessionsDir(), meta.id), { recursive: true, force: true });
      removed += 1;
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
  return removed;
}
