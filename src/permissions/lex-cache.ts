import { type ShellToken, lexShell } from "./shell";

// Per-check memo for the shell lexer. One bash command passes through the
// dangerous-command analysis, the sensitive-path tripwire and the
// allow/deny/ask rule matchers inside a single checkPermission call, and each
// stage used to re-lex the same command line (plus the same substitution
// bodies and sh -c scripts during recursion). Keyed by command string, so
// every stage and every recursive analysis of an identical script shares one
// lex. The map is created per check and never escapes it, keeping
// checkPermission a pure function of its arguments.
export type LexCache = Map<string, ShellToken[]>;

export function lexCached(cache: LexCache | undefined, command: string): ShellToken[] {
  if (cache === undefined) return lexShell(command);
  const hit = cache.get(command);
  if (hit !== undefined) return hit;
  const tokens = lexShell(command);
  cache.set(command, tokens);
  return tokens;
}
