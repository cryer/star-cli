const REGISTRY_URL = "https://registry.npmjs.org/@cryer%2fstar-cli/latest";
const TIMEOUT_MS = 5000;

export interface FetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type UpdateFetcher = (url: string) => Promise<FetchResponse>;

async function defaultFetcher(url: string): Promise<FetchResponse> {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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

export async function checkForUpdate(
  currentVersion: string,
  fetcher: UpdateFetcher = defaultFetcher,
): Promise<string | null> {
  try {
    const res = await fetcher(REGISTRY_URL);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    const latest =
      typeof data === "object" && data !== null ? (data as { version?: unknown }).version : null;
    if (typeof latest !== "string" || !isNewerVersion(latest, currentVersion)) return null;
    return `New version available: ${currentVersion} -> ${latest} — run: npm i -g @cryer/star-cli`;
  } catch {
    return null;
  }
}
