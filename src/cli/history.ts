import fs from "node:fs";
import path from "node:path";
import { starHome } from "../config/paths";

const DEFAULT_LIMIT = 500;
const MAX_FILE_LINES = 1000;
const TRIM_TO_LINES = 500;

function historyPath(): string {
  return path.join(starHome(), "history");
}

function readLines(file: string): string[] {
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
}

export function loadHistory(limit = DEFAULT_LIMIT): string[] {
  try {
    return readLines(historyPath()).slice(-limit);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string): void {
  const line = entry.replace(/[\r\n]+/g, " ").trim();
  if (line.length === 0) return;
  try {
    const file = historyPath();
    let existing: string[] = [];
    try {
      existing = readLines(file);
    } catch {
      // Missing or unreadable history file starts fresh.
    }
    if (existing[existing.length - 1] === line) return;
    if (existing.length >= MAX_FILE_LINES) {
      const kept = [...existing.slice(-(TRIM_TO_LINES - 1)), line];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${kept.join("\n")}\n`);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // History is best-effort and must never crash the REPL.
  }
}
