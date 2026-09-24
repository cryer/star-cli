import fs from "node:fs";
import { envFilePath } from "./paths";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Parses dotenv-style KEY=VALUE lines; blank lines and # comments are
// skipped, surrounding quotes on the value are stripped.
export function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

// Fills process.env from ~/.star-cli/.env. Variables already set in the real
// environment always win — the file only supplies missing values. Never
// throws: a missing or unreadable file means no keys.
export function loadEnvFile(filePath: string = envFilePath()): void {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parseEnvContent(content))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Returns content with key set to value: the existing KEY= line is replaced
// in place (comments and other variables untouched), otherwise a new line is
// appended.
export function upsertEnvContent(content: string, key: string, value: string): string {
  const entry = `${key}=${value.replace(/[\r\n]/g, "")}`;
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  const lines = content.split("\n");
  while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i] ?? "")) {
      lines[i] = entry;
      return `${lines.join("\n")}\n`;
    }
  }
  lines.push(entry);
  return `${lines.join("\n")}\n`;
}
