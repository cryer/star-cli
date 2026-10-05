import { formatSessionEntries, listSessionEntries } from "../session/list";

// Guards for the CLI entry paths, kept out of main.tsx (which parses argv at
// module scope) so tests can exercise them without launching commander.

export interface StartupStreams {
  stdinTTY: boolean;
  stdoutTTY: boolean;
}

// --image only has a consumer in print mode; without -p the file would be
// silently dropped when the REPL starts, so fail at startup instead.
export function imageRequiresPrintError(
  print: string | undefined,
  images: readonly string[],
): string | null {
  if (print !== undefined) return null;
  return images.length > 0 ? "--image requires -p/--print" : null;
}

// Ink needs a real terminal on both ends; piped stdin/stdout used to leave a
// bare stack or a hung process.
export function interactiveRequiresTtyError(streams: StartupStreams): string | null {
  return streams.stdinTTY && streams.stdoutTTY
    ? null
    : "interactive mode requires a TTY; use -p/--print";
}

// A downstream pipe that closes early (star -p "..." | head -1) turns the next
// stdout write into an EPIPE "error" event; exit quietly instead of dumping a
// raw stack.
export function installStdoutEpipeGuard(stdout: NodeJS.WriteStream = process.stdout): void {
  stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error?.code === "EPIPE") process.exit(0);
    else throw error;
  });
}

// `star -r` without an id prints the session picker list and leaves; a script
// must be able to tell "no sessions" apart from a successful listing, hence
// the non-zero code.
export async function reportResumeSessions(cwd: string): Promise<number> {
  const entries = await listSessionEntries(cwd);
  if (entries.length === 0) {
    console.error("No sessions found for this directory.");
    return 1;
  }
  console.log(formatSessionEntries(entries));
  return 0;
}
