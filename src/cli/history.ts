import fs from "node:fs";
import path from "node:path";
import { starHome } from "../config/paths";

const HISTORY_LIMIT = 50;
// A line made of one repeated character (20+) is key-repeat garbage, not input.
const JUNK_ENTRY_PATTERN = /^(.)\1{19,}$/;

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

function writeHistory(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

export function isJunkHistoryEntry(line: string): boolean {
  return JUNK_ENTRY_PATTERN.test(line);
}

// Slash commands are ephemeral REPL actions, not reusable input.
function isSkippableEntry(line: string): boolean {
  return isJunkHistoryEntry(line) || line.startsWith("/");
}

export function loadHistory(limit = HISTORY_LIMIT): string[] {
  try {
    const file = historyPath();
    const lines = readLines(file);
    const clean = lines.filter((line) => !isSkippableEntry(line));
    if (clean.length !== lines.length || clean.length > HISTORY_LIMIT) {
      // Self-heal: drop junk and enforce the cap so old polluted files recover.
      writeHistory(file, clean.slice(-HISTORY_LIMIT));
    }
    return clean.slice(-limit);
  } catch {
    return [];
  }
}

export function appendHistory(entry: string): void {
  const line = entry.replace(/[\r\n]+/g, " ").trim();
  if (line.length === 0 || isSkippableEntry(line)) return;
  try {
    const file = historyPath();
    let existing: string[] = [];
    try {
      existing = readLines(file);
    } catch {
      // Missing or unreadable history file starts fresh.
    }
    if (existing[existing.length - 1] === line) return;
    if (existing.length >= HISTORY_LIMIT) {
      writeHistory(file, [...existing.slice(-(HISTORY_LIMIT - 1)), line]);
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // History is best-effort and must never crash the REPL.
  }
}
