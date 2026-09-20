import path from "node:path";
import { isAllowedByRules } from "./allow";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "./types";

const FILE_TOOLS = new Set(["write_file", "edit_file", "read_file"]);

const DANGEROUS_COMMAND_PATTERNS = [
  /rm\s+-rf\s+\/(?:\s|$|;|&)/i,
  /rm\s+-rf\s+~(?:\s|\/|$|;|&)/i,
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

function isSensitivePath(p: string): boolean {
  const base = p.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  if (base === ".env.example" || base === ".env.sample" || base === ".env.template") {
    return false;
  }
  return base === ".env" || base.startsWith(".env.") || base === "id_rsa" || base.endsWith(".pem");
}

export function checkPermission(
  mode: PermissionMode,
  req: PermissionRequest,
  ctx: PermissionContext,
  allowRules: readonly string[] = [],
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
    if (
      (req.toolName === "write_file" || req.toolName === "edit_file") &&
      isSensitivePath(filePath)
    ) {
      return "deny";
    }
    if (isOutsideCwd(filePath, ctx.cwd)) {
      if (mode === "ask" && req.level === "read") {
        return "ask";
      }
      return "deny";
    }
  }

  if (mode === "auto") {
    return "allow";
  }
  if (mode === "readonly") {
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
      return "拒绝执行：违反权限模式或硬性安全规则";
    case "ask":
      return "需要用户确认后才能执行";
  }
}
