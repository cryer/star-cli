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

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function requestTarget(req: PermissionRequest): string | undefined {
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
  return target !== undefined && globToRegExp(rule.pattern).test(target);
}

// A rule with its glob pre-compiled; `pattern` stays undefined for bare
// tool-name rules. RegExp construction was the repeated cost of rule
// matching: it happened per rule per checked request.
export interface CompiledRule {
  toolName: string;
  pattern?: RegExp;
}

export function compileRule(raw: string): CompiledRule | null {
  const parsed = parseAllowRule(raw);
  if (parsed === null) return null;
  if (parsed.pattern === undefined) return { toolName: parsed.toolName };
  return { toolName: parsed.toolName, pattern: globToRegExp(parsed.pattern) };
}

// Compiled rules keyed by the identity of the rules array. The config's
// [permissions] tables are loaded once and reused for every checkPermission
// call, so an unchanged array never recompiles; a rebuilt array (config
// reload, the session's "always allow" list) misses once and re-caches, and
// the WeakMap lets the old entry be collected with the old array.
const compiledRuleCache = new WeakMap<readonly string[], (CompiledRule | null)[]>();

export function compiledRules(rules: readonly string[]): (CompiledRule | null)[] {
  const hit = compiledRuleCache.get(rules);
  if (hit !== undefined) return hit;
  const compiled = rules.map(compileRule);
  compiledRuleCache.set(rules, compiled);
  return compiled;
}

export function matchCompiledRule(rule: CompiledRule, req: PermissionRequest): boolean {
  if (rule.toolName !== req.toolName) return false;
  if (rule.pattern === undefined) return true;
  const target = requestTarget(req);
  return target !== undefined && rule.pattern.test(target);
}
