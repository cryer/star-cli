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

export function projectConfigPath(cwd: string): string {
  return path.join(cwd, ".star", "config.toml");
}
