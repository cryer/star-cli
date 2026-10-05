const SENSITIVE_BASENAMES = new Set([
  ".env",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  ".npmrc",
  ".netrc",
  ".pgpass",
]);

const SENSITIVE_SUFFIXES = [".pem", ".key", ".p12", ".pfx"];

const SENSITIVE_ENV_EXEMPTIONS = new Set([".env.example", ".env.sample", ".env.template"]);

// Additional likely-secret globs from the global config ([permissions]
// sensitive = [...]). The set is replaced wholesale on every config load, so
// an entry removed from the config stops protecting, and a project config
// can never add one (its [permissions] table is sandboxed away). Matching
// uses the same single-* glob semantics as permission rules, case-insensitively,
// against both the basename and the full normalized path ("/" separators).
const extraPatterns: string[] = [];

export function registerSensitivePatterns(patterns: readonly string[]): void {
  extraPatterns.length = 0;
  extraPatterns.push(...patterns.map((p) => p.trim()).filter((p) => p.length > 0));
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

function pathSegments(p: string): string[] {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .map((s) => s.toLowerCase());
}

// Single source of truth for "this file likely holds secrets, don't let the
// model read it into context or overwrite it". Matches on the basename, with
// two directory-aware rules for well-known credential locations. Templates
// and example env files are explicitly safe unless a configured glob says
// otherwise.
export function isSensitivePath(p: string): boolean {
  const segments = pathSegments(p);
  const base = segments[segments.length - 1] ?? "";
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  for (const pattern of extraPatterns) {
    const re = globToRegExp(pattern);
    if (re.test(normalized) || re.test(base)) {
      return true;
    }
  }
  if (SENSITIVE_ENV_EXEMPTIONS.has(base)) {
    return false;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (SENSITIVE_BASENAMES.has(base)) {
    return true;
  }
  if (SENSITIVE_SUFFIXES.some((suffix) => base.endsWith(suffix))) {
    return true;
  }
  const dir = segments[segments.length - 2] ?? "";
  if (dir === ".aws" && base === "credentials") {
    return true;
  }
  if (dir === ".kube" && base === "config") {
    return true;
  }
  return false;
}
