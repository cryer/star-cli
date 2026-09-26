import fs from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../core/sensitive";
import { isAllowedByRules, isDeniedByRules } from "./allow";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "./types";

const FILE_TOOLS = new Set(["write_file", "edit_file", "read_file", "grep", "glob"]);

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\/(?:\s|$|;|&)/i,
  /rm\s+-rf\s+~(?:\s|\/|$|;|&)/i,
  /rm\s+-rf\s+\.\/?(?:\s|$|;|&)/i,
  /rm\s+-rf\s+\*(?:\s|$|;|&)/i,
  /\bsudo\s+rm\b/i,
  /\bdel\s+\/s\b/i,
  /\brd\s+\/s\b/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  /\bmkfs\b/i,
  /dd\s+[^|;]*\bif=/i,
  />\s*\/dev\/sd[a-z]/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function getStringArg(args: unknown, key: string): string | undefined {
  if (typeof args === "object" && args !== null) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function normalizeAbsolute(p: string, cwd: string): string {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
  return abs.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isOutsideCwd(p: string, cwd: string): boolean {
  const abs = normalizeAbsolute(p, cwd);
  const base = normalizeAbsolute(cwd, cwd);
  return abs !== base && !abs.startsWith(`${base}/`);
}

// Resolves symlinks for a write target: the file itself when it exists,
// otherwise the nearest existing ancestor with the missing tail re-attached.
// Returns null when nothing on the path can be resolved.
function resolveRealPath(p: string, cwd: string): string | null {
  let current = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

// Outside-cwd check for write tools that sees through symlinks: a link inside
// cwd pointing outside must be treated as outside. Falls back to the plain
// string check when the path (or cwd) cannot be resolved.
function isOutsideForWrite(p: string, cwd: string): boolean {
  const resolved = resolveRealPath(p, cwd);
  if (resolved === null) return isOutsideCwd(p, cwd);
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    return isOutsideCwd(p, cwd);
  }
  return isOutsideCwd(resolved, realCwd);
}

export function checkPermission(
  mode: PermissionMode,
  req: PermissionRequest,
  ctx: PermissionContext,
  allowRules: readonly string[] = [],
  denyRules: readonly string[] = [],
): PermissionDecision {
  // yolo bypasses every check, including the hard safety rules below.
  if (mode === "yolo") {
    return "allow";
  }

  const command = getStringArg(req.args, "command");
  const filePath = getStringArg(req.args, "path");

  if (req.toolName === "bash" && command !== undefined && isDangerousCommand(command)) {
    return "deny";
  }

  if (FILE_TOOLS.has(req.toolName) && filePath !== undefined) {
    const isWriteTool = req.toolName === "write_file" || req.toolName === "edit_file";
    if (isWriteTool && isSensitivePath(filePath)) {
      return "deny";
    }
    const outside = isWriteTool
      ? isOutsideForWrite(filePath, ctx.cwd)
      : isOutsideCwd(filePath, ctx.cwd);
    if (outside) {
      if (mode === "ask" && req.level === "read") {
        return "ask";
      }
      return "deny";
    }
  }

  if (isDeniedByRules(denyRules, req)) {
    return "deny";
  }

  if (mode === "auto") {
    return "allow";
  }
  if (mode === "readonly") {
    return req.level === "read" ? "allow" : "deny";
  }
  if (mode === "plan") {
    return req.level === "read" ? "allow" : "deny";
  }
  if (isAllowedByRules(allowRules, req)) {
    return "allow";
  }
  return req.level === "read" ? "allow" : "ask";
}

export function describeDecision(decision: PermissionDecision): string {
  switch (decision) {
    case "allow":
      return "允许执行该操作";
    case "deny":
      return "拒绝执行：违反权限模式、硬性安全规则或配置的拒绝规则";
    case "ask":
      return "需要用户确认后才能执行";
  }
}
