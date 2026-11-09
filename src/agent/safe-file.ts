import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../core/sensitive";

export interface ContainedTextFile {
  content: string;
  mtimeMs: number;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function readContainedTextFile(
  boundaryDir: string,
  rootDir: string,
  filePath: string,
  maxChars: number,
): ContainedTextFile | null {
  let handle: number | undefined;
  try {
    const boundary = realpathSync(boundaryDir);
    const root = realpathSync(rootDir);
    const resolved = realpathSync(filePath);
    if (!isInside(boundary, root) || !isInside(root, resolved)) return null;
    if (isSensitivePath(filePath) || isSensitivePath(resolved)) return null;
    const st = statSync(resolved);
    if (!st.isFile()) return null;
    handle = openSync(resolved, "r");
    const buffer = Buffer.alloc(maxChars * 4 + 4);
    const bytesRead = readSync(handle, buffer, 0, buffer.length, 0);
    return { content: buffer.toString("utf8", 0, bytesRead), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  } finally {
    if (handle !== undefined) {
      try {
        closeSync(handle);
      } catch {}
    }
  }
}
