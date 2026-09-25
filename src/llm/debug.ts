import { appendFileSync } from "node:fs";
import path from "node:path";
import { starHome } from "../config/paths";

// STAR_DEBUG-gated JSONL log of stream internals (~/.star-cli/debug.log):
// what the provider actually sent — finish reasons, usage, error details —
// so a misbehaving relay can be diagnosed from the client side. All write
// failures are silent; logging must never break a turn.
export function debugStreamLog(event: string, data?: Record<string, unknown>): void {
  if (!process.env.STAR_DEBUG) return;
  try {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), event, ...data })}\n`;
    appendFileSync(path.join(starHome(), "debug.log"), line);
  } catch {
    // best-effort only
  }
}
