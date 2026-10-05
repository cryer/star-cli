import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { starHome } from "../config/paths";

const REGISTRY_URL = "https://registry.npmjs.org/@cryer%2fstar-cli/latest";
const TIMEOUT_MS = 5000;
// One registry hit per day at most: the REPL calls this on every startup.
const THROTTLE_MS = 24 * 60 * 60 * 1000;

export interface FetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type UpdateFetcher = (url: string) => Promise<FetchResponse>;

async function defaultFetcher(url: string): Promise<FetchResponse> {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
}

interface UpdateCheckState {
  lastCheckAt: number;
  latest: string | null;
}

function defaultStatePath(): string {
  return path.join(starHome(), "update-check.json");
}

// Missing or corrupt state is indistinguishable from "never checked" — this
// file is a cache, so any read problem just means "fetch again".
async function readState(statePath: string): Promise<UpdateCheckState | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const { lastCheckAt, latest } = raw as { lastCheckAt?: unknown; latest?: unknown };
    if (typeof lastCheckAt !== "number" || !Number.isFinite(lastCheckAt)) return null;
    return { lastCheckAt, latest: typeof latest === "string" ? latest : null };
  } catch {
    return null;
  }
}

// Best-effort atomic write (tmp + rename); a cache must never break startup.
async function writeState(statePath: string, state: UpdateCheckState): Promise<void> {
  try {
    await mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(state), "utf8");
    await rename(tmp, statePath);
  } catch {
    // ignore
  }
}

export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .split(".")
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10));
  const a = parse(latest);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

function noticeFor(latest: string | null, currentVersion: string): string | null {
  if (typeof latest !== "string" || !isNewerVersion(latest, currentVersion)) return null;
  return `New version available: ${currentVersion} -> ${latest} — run: npm i -g @cryer/star-cli`;
}

export async function checkForUpdate(
  currentVersion: string,
  fetcher: UpdateFetcher = defaultFetcher,
  statePath: string = defaultStatePath(),
): Promise<string | null> {
  try {
    // Throttle: within the window the cached registry answer is replayed
    // (recomputed against the CURRENT version, so upgrading the CLI between
    // startups still drops the notice) and no request is sent.
    const state = await readState(statePath);
    if (state && Date.now() - state.lastCheckAt < THROTTLE_MS) {
      return noticeFor(state.latest, currentVersion);
    }
    const res = await fetcher(REGISTRY_URL);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const latest =
      typeof data === "object" && data !== null ? (data as { version?: unknown }).version : null;
    // Only a successful check re-arms the window: failures keep today's
    // semantics (silently retried on the next startup).
    await writeState(statePath, {
      lastCheckAt: Date.now(),
      latest: typeof latest === "string" ? latest : null,
    });
    return noticeFor(typeof latest === "string" ? latest : null, currentVersion);
  } catch {
    return null;
  }
}
