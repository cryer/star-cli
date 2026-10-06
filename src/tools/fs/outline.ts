import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../types";
import {
  WALK_CONCURRENCY,
  type WalkedFile,
  createIgnorePredicate,
  isSensitivePath,
  walkFiles,
} from "./util";

const MAX_DIR_FILES = 60;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS_PER_FILE = 150;
const MAX_LINE_CHARS = 200;
const MAX_OUT_CHARS = 30 * 1024;
// Nesting is shown through original indentation, capped so deep nesting
// cannot push the signature out of view.
const MAX_INDENT_CHARS = 8;

// Declaration-spotting regexes per language family. This is deliberately a
// lightweight skeleton extractor, not a parser: it misses some declarations
// (multi-line signatures, macros) and that is fine — the outline exists so
// the model can navigate to line ranges cheaply; read_file still owns exact
// content. Patterns are anchored to declaration shapes (leading modifiers,
// trailing "{"/";"/end-of-line) so ordinary calls and control flow don't
// match, and are tested against the raw line because member rules key on
// indentation (methods are indented, top-level declarations are not).
const KEYWORD_EXCLUSION =
  "(?!if\\b|for\\b|while\\b|switch\\b|catch\\b|return\\b|else\\b|do\\b|new\\b|throw\\b)";

const TS_MEMBER_MODIFIERS =
  "(?:public|private|protected|static|async|readonly|get|set|override|abstract)";

const TS_LIKE = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+[\w$]+/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+[\w$]+/,
  /^(?:export\s+)?interface\s+[\w$]+/,
  /^(?:export\s+)?type\s+[\w$]+\s*=/,
  /^(?:export\s+)?(?:const\s+)?enum\s+[\w$]+/,
  // const handler = (a, b) => / const handler = async (a) => — top level
  // only; locals inside functions are navigation noise.
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  // Indented class/object members with a body: name<T>(args): ReturnType {
  // — control flow excluded by the keyword lookahead, dotted calls
  // (this.x()) fail the anchored name-then-paren shape.
  new RegExp(
    `^\\s+(?:${TS_MEMBER_MODIFIERS}\\s+)*${KEYWORD_EXCLUSION}[\\w$]+(?:<[^>]*>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^{}=;]+?)?\\s*(?:\\{\\s*)?\\}?\\s*$`,
  ),
  // Bodyless signatures (interface members, overloads): only when the
  // parens carry type annotations or an explicit return type follows —
  // otherwise indented calls like clearTimeout(timer); or finalize();
  // would leak into the outline.
  new RegExp(
    `^\\s+(?:${TS_MEMBER_MODIFIERS}\\s+)*${KEYWORD_EXCLUSION}[\\w$]+(?:<[^>]*>)?\\s*(?:\\([^)]*:[^)]*\\)\\s*(?::\\s*[^{}=;]+?)?|\\([^)]*\\)\\s*:\\s*[^{}=;]+?)\\s*;\\s*$`,
  ),
];

const LANGUAGE_PATTERNS: Record<string, RegExp[]> = {
  ts: TS_LIKE,
  python: [/^\s*(?:async\s+)?def\s+\w+\s*\(/, /^\s*class\s+\w+/],
  go: [/^func\s+(?:\([^)]*\)\s*)?\w+\s*\(/, /^type\s+\w+\s+(?:struct|interface)\b/],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+\w+/,
    /^\s*(?:pub\s+)?(?:struct|enum|trait|union)\s+\w+/,
  ],
  jvm: [
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|suspend|inline|override|async|partial|virtual|extern)\s+)*(?:class|interface|enum|struct|record|object)\s+\w+/,
    /^\s*(?:(?:public|private|protected|internal|open|suspend|inline|override)\s+)*fun\s+\w+\s*\(/,
    new RegExp(
      `^\\s+(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|suspend|inline|override|async|partial|virtual)\\s+)*[\\w<>[\\],.?]+\\s+${KEYWORD_EXCLUSION}\\w+\\s*\\([^;{}]*\\)\\s*(?:\\{|;|=>|$)`,
    ),
  ],
  cpp: [
    /^\s*(?:class|struct|enum|union|namespace)\s+\w+/,
    new RegExp(
      `^\\s*(?:(?:static|inline|virtual|constexpr|extern|friend|explicit)\\s+)*[\\w:<>,~*&\\s]+?\\s+${KEYWORD_EXCLUSION}[\\w:~]+\\s*\\([^;]*\\)\\s*(?:const\\s*)?(?:noexcept\\s*)?(?:\\{|;|$)`,
    ),
  ],
  ruby: [/^\s*def\s+[\w.=!?]+/, /^\s*(?:class|module)\s+[\w:]+/],
  php: [
    /^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+\w+\s*\(/,
    /^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+\w+/,
  ],
  shell: [/^\s*(?:function\s+)?[\w.-]+\s*\(\s*\)\s*(?:\{|$)/],
  swift: [
    /^\s*(?:(?:public|private|internal|open|fileprivate|static|class|override|mutating|final)\s+)*func\s+\w+\s*\(/,
    /^\s*(?:(?:public|private|internal|open|final)\s+)*(?:class|struct|enum|protocol|extension)\s+\w+/,
  ],
  scala: [
    /^\s*(?:(?:private|protected|override|final|abstract|implicit)\s+)*def\s+\w+\s*[(\[]/,
    /^\s*(?:(?:abstract|final|sealed)\s+)*(?:class|trait|object)\s+\w+/,
  ],
};

const EXT_TO_LANGUAGE: Record<string, keyof typeof LANGUAGE_PATTERNS> = {
  ts: "ts",
  tsx: "ts",
  mts: "ts",
  cts: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  java: "jvm",
  kt: "jvm",
  kts: "jvm",
  cs: "jvm",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  rb: "ruby",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  swift: "swift",
  scala: "scala",
  sc: "scala",
};

function languageOf(filePath: string): RegExp[] | undefined {
  const name = path.basename(filePath);
  // Minified and machine-generated bundles are declaration soup; outlining
  // a bundled dependency is never useful navigation.
  if (/\.(min|bundle|generated)\.[^.]+$/.test(name)) return undefined;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_TO_LANGUAGE[ext];
  return lang === undefined ? undefined : LANGUAGE_PATTERNS[lang];
}

interface SymbolLine {
  line: number;
  indent: string;
  text: string;
}

function extractSymbols(text: string, patterns: RegExp[]): SymbolLine[] {
  const out: SymbolLine[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = (lines[i] ?? "").replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (!patterns.some((re) => re.test(raw))) continue;
    const indent = raw.slice(0, raw.length - raw.trimStart().length).slice(0, MAX_INDENT_CHARS);
    const shown =
      trimmed.length > MAX_LINE_CHARS ? `${trimmed.slice(0, MAX_LINE_CHARS)}…` : trimmed;
    out.push({ line: i + 1, indent, text: shown });
  }
  return out;
}

async function outlineFile(
  abs: string,
): Promise<{ symbols: SymbolLine[]; total: number } | { binary: true } | { unreadable: true }> {
  const st = await stat(abs).catch(() => null);
  if (!st || st.size > MAX_FILE_BYTES) return { unreadable: true };
  const buf = await readFile(abs).catch(() => null);
  if (!buf) return { unreadable: true };
  if (buf.includes(0)) return { binary: true };
  const patterns = languageOf(abs);
  if (!patterns) return { unreadable: true };
  const all = extractSymbols(buf.toString("utf8"), patterns);
  return { symbols: all.slice(0, MAX_SYMBOLS_PER_FILE), total: all.length };
}

function formatSymbols(symbols: SymbolLine[], total: number): string[] {
  const out = symbols.map((s) => `${s.line}\t${s.indent}${s.text}`);
  if (total > symbols.length) {
    out.push(`... (${total - symbols.length} more declarations)`);
  }
  return out;
}

const schema = z.object({
  path: z
    .string()
    .optional()
    .describe("Source file or directory to outline (default: the working directory)"),
  maxFiles: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Directory mode: maximum files to include (default ${MAX_DIR_FILES})`),
});

export const codeOutlineTool: Tool<typeof schema> = {
  name: "code_outline",
  description:
    "List the declaration skeleton of a source file or directory (functions, classes, methods, types) with line numbers, without reading the bodies. Cheaper than read_file for navigating unfamiliar code: outline first, then read_file the exact line ranges you need. Supports TS/JS, Python, Go, Rust, Java/Kotlin/C#, C/C++, Ruby, PHP, Shell, Swift, Scala.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const root = path.resolve(ctx.cwd, args.path ?? ".");
    const st = await stat(root).catch(() => null);
    if (!st) {
      return { content: `Path not found: ${args.path ?? "."}`, isError: true };
    }

    if (st.isFile()) {
      // Same refusal as read_file: the raw name and the symlink target both
      // count, so a planted link cannot launder a sensitive basename.
      const resolved = await realpath(root).catch(() => null);
      if (isSensitivePath(root) || (resolved !== null && isSensitivePath(resolved))) {
        return { content: `Refused to outline sensitive file: ${args.path ?? "."}`, isError: true };
      }
      if (languageOf(root) === undefined) {
        return {
          content: `No supported source language for: ${args.path ?? "."} (supported: TS/JS, Python, Go, Rust, Java/Kotlin/C#, C/C++, Ruby, PHP, Shell, Swift, Scala)`,
        };
      }
      const result = await outlineFile(root);
      if ("binary" in result) {
        return { content: `Cannot outline binary file: ${args.path ?? "."}`, isError: true };
      }
      if ("unreadable" in result) {
        return {
          content: `Cannot outline ${args.path ?? "."}: unreadable or larger than 2MB`,
          isError: true,
        };
      }
      if (result.symbols.length === 0) {
        return { content: `(no recognizable declarations in ${args.path ?? "."})` };
      }
      return { content: formatSymbols(result.symbols, result.total).join("\n") };
    }

    const walked = await walkFiles(root, undefined, {
      ignore: createIgnorePredicate(ctx.cwd),
      withMtime: false,
      signal: ctx.abortSignal,
      symlinkBoundary: ctx.cwd,
      nestedIgnore: true,
    });
    const candidates = walked.files.filter(
      (f) =>
        languageOf(f.abs) !== undefined &&
        !isSensitivePath(f.abs) &&
        (f.resolved === undefined || !isSensitivePath(f.resolved)),
    );
    const maxFiles = args.maxFiles ?? MAX_DIR_FILES;

    const scan = async (
      file: WalkedFile,
    ): Promise<{ rel: string; lines: string[]; chars: number } | null> => {
      const result = await outlineFile(file.abs);
      if ("symbols" in result && result.symbols.length > 0) {
        const lines = formatSymbols(result.symbols, result.total);
        const chars = lines.reduce((n, l) => n + l.length + 1, file.rel.length + 2);
        return { rel: file.rel, lines, chars };
      }
      return null;
    };

    const out: string[] = [];
    let size = 0;
    let included = 0;
    let hitLimit = false;
    for (let i = 0; i < candidates.length && included < maxFiles; i += WALK_CONCURRENCY) {
      if (ctx.abortSignal?.aborted) break;
      const chunk = await Promise.all(
        candidates.slice(i, i + WALK_CONCURRENCY).map((file) => scan(file)),
      );
      for (const block of chunk) {
        if (!block) continue;
        if (size + block.chars > MAX_OUT_CHARS || included >= maxFiles) {
          hitLimit = true;
          break;
        }
        if (out.length > 0) out.push("");
        out.push(`${block.rel}:`);
        out.push(...block.lines);
        size += block.chars;
        included += 1;
      }
      if (hitLimit) break;
    }
    if (included === 0) {
      return {
        content: `No recognizable declarations under ${args.path ?? "."} (${candidates.length} source file(s) scanned)`,
      };
    }
    if (hitLimit) {
      out.push("... (truncated: output limit reached, more files not outlined)");
    } else if (walked.aborted || ctx.abortSignal?.aborted) {
      out.push("... (interrupted: partial results)");
    }
    return { content: out.join("\n") };
  },
};
