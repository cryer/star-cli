import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg: unknown = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    if (typeof pkg === "object" && pkg !== null) {
      const version = (pkg as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // fall through to placeholder
  }
  return "0.0.0";
}

export const VERSION = readPackageVersion();
