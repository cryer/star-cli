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

export function isAllowedByRules(rules: readonly string[], req: PermissionRequest): boolean {
  return rules.some((raw) => {
    const rule = parseAllowRule(raw);
    return rule !== null && matchAllowRule(rule, req);
  });
}

export function buildAllowRule(req: PermissionRequest): string {
  const target = requestTarget(req);
  return target !== undefined ? `${req.toolName}(${target})` : req.toolName;
}
