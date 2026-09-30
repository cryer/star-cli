// Shell command lexer shared by the permission gate (dangerous-command
// analysis) and allow/deny rule matching. Not a full POSIX grammar — just
// enough structure that quoting, variable expansion and command/process
// substitution can no longer hide what a command line actually runs.
//
// Word tokens have their quotes stripped and `$VAR` / `${VAR}` expansions
// normalized to `$VAR` so callers can recognize well-known names ($HOME)
// without caring about the spelling. The lexer never fails: unterminated
// quotes or substitutions simply consume the rest of the input.

export type ShellOperator =
  | "&&"
  | "||"
  | "&"
  | "|"
  | ";"
  | "\n"
  | "("
  | ")"
  | ">"
  | ">>"
  | "<"
  | ">&"
  | "<&";

export type ShellToken =
  | { kind: "word"; text: string }
  | { kind: "op"; op: ShellOperator }
  // `$(...)` / backticks (process:false) and `>(...)` / `<(...)`
  // (process:true) carry their inner command line for recursive analysis.
  | { kind: "subst"; inner: string; process: boolean };

export const REDIRECT_OPS: ReadonlySet<ShellOperator> = new Set([">", ">>", "<", ">&", "<&"]);

// Redirects that touch a file (fd duplication like 2>&1 is harmless).
export const FILE_REDIRECT_OPS: ReadonlySet<ShellOperator> = new Set([">", ">>", "<"]);

const SEGMENT_SEPARATORS: ReadonlySet<ShellOperator> = new Set([
  "&&",
  "||",
  "&",
  "|",
  ";",
  "\n",
  "(",
  ")",
]);

export function lexShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let word = "";
  let doubleQuoted = false;
  let i = 0;

  const flush = () => {
    if (word.length > 0) {
      tokens.push({ kind: "word", text: word });
      word = "";
    }
  };

  // Index just past the ")" closing the "(" at `from`; -1 when unterminated.
  // Skips over quoted strings and nested parentheses.
  const findCloseParen = (from: number): number => {
    let depth = 0;
    let j = from;
    while (j < command.length) {
      const c = command[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        const close = command.indexOf(c, j + 1);
        j = close === -1 ? command.length : close + 1;
        continue;
      }
      if (c === "(") depth += 1;
      if (c === ")") {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return -1;
  };

  const pushSubstitution = (openParen: number, process: boolean): number => {
    const close = findCloseParen(openParen);
    const innerEnd = close === -1 ? command.length : close - 1;
    flush();
    tokens.push({ kind: "subst", inner: command.slice(openParen + 1, innerEnd), process });
    return close === -1 ? command.length : close;
  };

  const lexDollarOrBacktick = (pos: number): number => {
    const c = command[pos];
    if (c === "`") {
      const close = command.indexOf("`", pos + 1);
      const end = close === -1 ? command.length : close;
      flush();
      tokens.push({ kind: "subst", inner: command.slice(pos + 1, end), process: false });
      return close === -1 ? command.length : close + 1;
    }
    const next = command[pos + 1];
    if (next === "(") {
      return pushSubstitution(pos + 1, false);
    }
    if (next === "{") {
      const close = command.indexOf("}", pos + 2);
      if (close !== -1) {
        word += `$${command.slice(pos + 2, close)}`;
        return close + 1;
      }
      word += "$";
      return pos + 1;
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let end = pos + 1;
      while (end < command.length && /[A-Za-z0-9_]/.test(command[end] ?? "")) {
        end += 1;
      }
      word += command.slice(pos, end);
      return end;
    }
    word += "$";
    return pos + 1;
  };

  while (i < command.length) {
    const c = command[i] as string;
    if (doubleQuoted) {
      if (c === '"') {
        doubleQuoted = false;
        i += 1;
      } else if (c === "\\") {
        if (i + 1 < command.length) {
          word += command[i + 1];
          i += 2;
        } else {
          word += "\\";
          i += 1;
        }
      } else if (c === "$" || c === "`") {
        i = lexDollarOrBacktick(i);
      } else {
        word += c;
        i += 1;
      }
      continue;
    }
    if (c === "\\") {
      if (i + 1 < command.length) {
        word += command[i + 1];
        i += 2;
      } else {
        word += "\\";
        i += 1;
      }
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(i + 1, end);
      i = close === -1 ? command.length : close + 1;
      continue;
    }
    if (c === '"') {
      doubleQuoted = true;
      i += 1;
      continue;
    }
    if (c === "$" || c === "`") {
      i = lexDollarOrBacktick(i);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flush();
      i += 1;
      continue;
    }
    if (c === "\n") {
      flush();
      tokens.push({ kind: "op", op: "\n" });
      i += 1;
      continue;
    }
    if (c === "&" || c === "|") {
      flush();
      if (command[i + 1] === c) {
        tokens.push({ kind: "op", op: c === "&" ? "&&" : "||" });
        i += 2;
      } else {
        tokens.push({ kind: "op", op: c });
        i += 1;
      }
      continue;
    }
    if (c === ";" || c === "(" || c === ")") {
      flush();
      tokens.push({ kind: "op", op: c });
      i += 1;
      continue;
    }
    if (c === ">" || c === "<") {
      flush();
      const next = command[i + 1];
      if (next === "(") {
        i = pushSubstitution(i + 1, true);
        continue;
      }
      if (c === ">" && next === ">") {
        tokens.push({ kind: "op", op: ">>" });
        i += 2;
      } else if (next === "&") {
        tokens.push({ kind: "op", op: c === ">" ? ">&" : "<&" });
        i += 2;
      } else {
        tokens.push({ kind: "op", op: c });
        i += 1;
      }
      continue;
    }
    word += c;
    i += 1;
  }
  flush();
  return tokens;
}

// Splits a token stream at command boundaries (&&, ||, &, |, ;, newlines and
// subshell parens); empty segments are dropped.
export function splitShellSegments(tokens: ShellToken[]): ShellToken[][] {
  const segments: ShellToken[][] = [];
  let current: ShellToken[] = [];
  for (const token of tokens) {
    if (token.kind === "op" && SEGMENT_SEPARATORS.has(token.op)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

// Extracts the plain words of a segment, dropping redirection operators and
// their targets (collected in `redirectTargets`). Substitution tokens are
// skipped — callers analyze them separately.
export function segmentWords(segment: ShellToken[]): {
  words: string[];
  redirectTargets: string[];
} {
  const words: string[] = [];
  const redirectTargets: string[] = [];
  for (let k = 0; k < segment.length; k += 1) {
    const token = segment[k] as ShellToken;
    if (token.kind === "op" && REDIRECT_OPS.has(token.op)) {
      const target = segment[k + 1];
      if (target?.kind === "word") {
        redirectTargets.push(target.text);
        k += 1;
      }
      continue;
    }
    if (token.kind === "word") {
      words.push(token.text);
    }
  }
  return { words, redirectTargets };
}

// Re-renders a segment for rule matching: words and operators joined with
// single spaces (quotes and expansions were already normalized by the lexer).
export function renderSegment(segment: ShellToken[]): string {
  return segment
    .map((token) => {
      if (token.kind === "word") return token.text;
      if (token.kind === "op") return token.op;
      return token.process ? ">(…)" : "$(…)";
    })
    .join(" ");
}
