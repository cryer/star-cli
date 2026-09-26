import os from "node:os";
import path from "node:path";

export function starHome(): string {
  return process.env.STAR_HOME ?? path.join(os.homedir(), ".star-cli");
}

export function globalConfigPath(): string {
  return path.join(starHome(), "config.toml");
}

export function sessionsDir(): string {
  return path.join(starHome(), "sessions");
}

export function userMemoryPath(): string {
  return path.join(starHome(), "MEMORY.md");
}

// Internal bare git repositories tracking the whole working tree per project
// directory (one per cwd, keyed by base64url of the resolved path) for the
// git-snapshot /undo//redo path. Kept outside the user's own .git.
export function gitTreesDir(): string {
  return path.join(starHome(), "git-trees");
}

// dotenv-style API key store written by /connect; config.toml only references
// the variable names (apiKeyEnv), never the keys themselves.
export function envFilePath(): string {
  return path.join(starHome(), ".env");
}

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".star", "config.toml");
}
