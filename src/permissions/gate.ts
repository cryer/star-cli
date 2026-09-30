import fs from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../core/sensitive";
import { isAllowedByRules, isDeniedByRules } from "./allow";
import { type ShellToken, lexShell, segmentWords, splitShellSegments } from "./shell";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "./types";

const FILE_TOOLS = new Set(["write_file", "edit_file", "read_file", "read_image", "grep", "glob"]);

// The classic fork bomb is punctuation soup that defeats word-level analysis;
// keep a literal regex for it.
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/;

const MAX_ANALYSIS_DEPTH = 8;

function baseName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, "");
}

// Paths whose recursive deletion (or permission wipe) is never acceptable:
// filesystem / home / cwd roots, bare globs and drive roots. `$VAR` and
// `${VAR}` were normalized to `$VAR` by the lexer, so well-known home
// variables are recognizable here.
function isDangerousDeleteTarget(target: string): boolean {
  if (/^\/+$/.test(target)) return true;
  const norm = target.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === "/*" || norm === "*") return true;
  if (norm === "~" || norm.startsWith("~/")) return true;
  if (norm === "." || norm === "./*") return true;
  if (/^[a-zA-Z]:$/.test(norm)) return true;
  if (["$HOME", "$USERPROFILE", "$HOMEPATH"].includes(norm)) return true;
  if (/^%(USERPROFILE|HOMEDRIVE|HOMEPATH)%$/i.test(norm)) return true;
  return false;
}

function rmIsDangerous(args: string[]): boolean {
  let recursive = false;
  let optionsDone = false;
  const targets: string[] = [];
  for (const arg of args) {
    if (!optionsDone && arg === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith("-")) {
      if (arg === "--recursive") {
        recursive = true;
      } else if (!arg.startsWith("--") && /[rR]/.test(arg)) {
        recursive = true;
      }
      continue;
    }
    targets.push(arg);
  }
  return recursive && targets.some(isDangerousDeleteTarget);
}

function findIsDangerous(args: string[]): boolean {
  if (!args.includes("-delete")) return false;
  const paths: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "(" || arg === ")" || arg === "!" || arg === ",") {
      break;
    }
    paths.push(arg);
  }
  // No explicit path means "everything below the cwd".
  return paths.length === 0 || paths.some(isDangerousDeleteTarget);
}

const XARGS_VALUE_OPTS = new Set([
  "-I",
  "-n",
  "-P",
  "-s",
  "-L",
  "-d",
  "-E",
  "-a",
  "--replace",
  "--max-args",
  "--max-procs",
  "--max-lines",
  "--delimiter",
  "--eof",
  "--arg-file",
  "--interactive",
  "--exit",
]);

// `xargs rm` takes its deletion targets from stdin, so no target analysis is
// possible — any rm (or rm-equivalent) invoked through xargs is refused.
function xargsIsDangerous(args: string[]): boolean {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] as string;
    if (XARGS_VALUE_OPTS.has(arg)) {
      k += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return baseName(arg) === "rm";
  }
  return false;
}

function chmodIsDangerous(args: string[]): boolean {
  let recursive = false;
  let optionsDone = false;
  const operands: string[] = [];
  for (const arg of args) {
    if (!optionsDone && arg === "--") {
      optionsDone = true;
      continue;
    }
    if (!optionsDone && arg.startsWith("-")) {
      if (arg === "--recursive" || (!arg.startsWith("--") && arg.includes("R"))) {
        recursive = true;
      }
      continue;
    }
    operands.push(arg);
  }
  // operands[0] is the mode; the rest are targets.
  return recursive && operands.slice(1).some(isDangerousDeleteTarget);
}

interface CommandInvocation {
  name: string;
  rest: string[];
  sudo: boolean;
}

// Strips leading VAR=value assignments and sudo/doas/env wrappers (with their
// flags) to find the command actually being run.
function commandInvocation(words: string[]): CommandInvocation | null {
  let sudo = false;
  let wrapped = false;
  let k = 0;
  for (;;) {
    const word = words[k];
    if (word === undefined) return null;
    const lower = word.toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      k += 1;
      continue;
    }
    if (lower === "sudo" || lower === "doas" || lower === "env") {
      sudo = sudo || lower !== "env";
      wrapped = true;
      k += 1;
      continue;
    }
    if (wrapped && word.startsWith("-")) {
      k += 1;
      continue;
    }
    return { name: baseName(word), rest: words.slice(k + 1), sudo };
  }
}

function commandLineIsDangerous(command: string, depth: number): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) return true;
  const tokens = lexShell(command);
  for (const token of tokens) {
    if (token.kind === "subst" && commandLineIsDangerous(token.inner, depth + 1)) {
      return true;
    }
  }
  return splitShellSegments(tokens).some((segment) => segmentIsDangerous(segment, depth));
}

function segmentIsDangerous(segment: ShellToken[], depth: number): boolean {
  const { words, redirectTargets } = segmentWords(segment);
  if (redirectTargets.some((target) => /^\/dev\/sd[a-z]/i.test(target))) {
    return true;
  }
  const invocation = commandInvocation(words);
  if (!invocation) return false;
  const { name, rest, sudo } = invocation;
  if (sudo && name === "rm") return true;
  switch (name) {
    case "shutdown":
    case "reboot":
    case "poweroff":
    case "halt":
    case "diskpart":
    case "wipefs":
    case "shred":
      return true;
    case "rm":
      return rmIsDangerous(rest);
    case "rmdir":
    case "rd":
    case "del":
    case "erase":
      return rest.some((arg) => /^\/s$/i.test(arg));
    case "format":
      return rest.some((arg) => /^[a-z]:$/i.test(arg));
    case "dd":
      return rest.some((arg) => arg.startsWith("if="));
    case "find":
      return findIsDangerous(rest);
    case "xargs":
      return xargsIsDangerous(rest);
    case "chmod":
      return chmodIsDangerous(rest);
    case "systemctl":
      return rest.some((arg) => ["poweroff", "halt", "reboot"].includes(arg.toLowerCase()));
    case "init":
      return rest.some((arg) => arg === "0" || arg === "6");
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ash": {
      const idx = rest.indexOf("-c");
      const script = idx >= 0 ? rest[idx + 1] : undefined;
      return script !== undefined && commandLineIsDangerous(script, depth + 1);
    }
    case "eval":
      return rest.length > 0 && commandLineIsDangerous(rest.join(" "), depth + 1);
    case "cmd": {
      const idx = rest.findIndex((arg) => /^\/c$/i.test(arg));
      if (idx < 0) return false;
      const script = rest.slice(idx + 1).join(" ");
      return script.length > 0 && commandLineIsDangerous(script, depth + 1);
    }
    default:
      return name.startsWith("mkfs") && (name.length === 4 || /[.-]/.test(name.charAt(4)));
  }
}

// Dangerous-command analysis runs on a lexed token stream (quotes stripped,
// $VAR/${VAR} normalized, $(...)/backtick/`sh -c` arguments recursed into),
// so flag order, quoting and wrapper commands cannot smuggle a blocked
// payload past it. yolo mode bypasses even this.
export function isDangerousCommand(command: string): boolean {
  if (FORK_BOMB.test(command)) return true;
  return commandLineIsDangerous(command, 0);
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

// Resolves symlinks for a target: the file itself when it exists, otherwise
// the nearest existing ancestor with the missing tail re-attached. Returns
// null when nothing on the path can be resolved.
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

// Outside-cwd check that sees through symlinks: a link inside cwd pointing
// outside must be treated as outside — for write tools, and equally for read
// tools, which otherwise leak outside files (e.g. a repo symlink pointing at
// ~/.ssh) in auto mode. Falls back to the plain string check when the path
// (or cwd) cannot be resolved.
function isOutsideResolved(p: string, cwd: string): boolean {
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
    if (isOutsideResolved(filePath, ctx.cwd)) {
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
