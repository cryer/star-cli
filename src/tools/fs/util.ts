import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist"]);

export interface WalkedFile {
  abs: string;
  rel: string;
  mtimeMs: number;
}

export async function walkFiles(
  root: string,
  skipDirs: Set<string> = SKIP_DIRS,
): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  async function walk(dir: string, relBase: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) {
          await walk(abs, rel);
        }
      } else if (entry.isFile()) {
        try {
          const st = await stat(abs);
          out.push({ abs, rel, mtimeMs: st.mtimeMs });
        } catch {
          // ignore unreadable entries
        }
      }
    }
  }
  await walk(root, "");
  return out;
}

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*") {
      if (pattern.charAt(i + 1) === "*") {
        i += 2;
        if (pattern.charAt(i) === "/") {
          i += 1;
          re += "(?:[^/]+/)*";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(REGEX_SPECIALS, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesGlob(pattern: string, relPath: string): boolean {
  const normalized = pattern.replace(/\\/g, "/");
  if (!normalized.includes("/")) {
    const base = relPath.split("/").pop() ?? relPath;
    return globToRegExp(normalized).test(base);
  }
  return globToRegExp(normalized).test(relPath);
}

export function isSensitivePath(filePath: string): boolean {
  const base = path.basename(filePath);
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") {
    return false;
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return true;
  }
  if (base === "id_rsa" || base.endsWith(".pem")) {
    return true;
  }
  return false;
}
