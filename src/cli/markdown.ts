// Minimal markdown renderer for terminal output: compiles a markdown subset
// (headings, bold/italic/strikethrough, inline code, fenced code blocks,
// links, images, blockquotes, horizontal rules, pipe tables) into an
// ANSI-styled string suitable for a single Ink <Text> node.
//
// `base` is the ANSI SGR code of the surrounding text color (e.g. "32" for
// the green assistant text): every styled span ends with a full reset, so
// the base must be re-opened after each span or the rest of the line would
// lose its color.
//
// Streaming-safe: unclosed inline markers and fences render as literal text
// until completed. Width accounting uses display cells (CJK/emoji = 2) so
// tables stay aligned for CJK content.

const ESC = "\u001B[";
const RESET = `${ESC}0m`;

function styled(open: string, text: string, base: string): string {
  const reopen = base ? `${ESC}${base}m` : "";
  return `${ESC}${open}m${text}${RESET}${reopen}`;
}

const bold = (t: string, b: string) => styled("1", t, b);
const dim = (t: string, b: string) => styled("2", t, b);
const italic = (t: string, b: string) => styled("3", t, b);
const underline = (t: string, b: string) => styled("4", t, b);
const strike = (t: string, b: string) => styled("9", t, b);
const yellow = (t: string, b: string) => styled("33", t, b);
const cyanBold = (t: string, b: string) => styled("1;36", t, b);

// Display width in terminal cells: CJK-wide and emoji ranges count 2,
// combining marks / ZWJ / variation selectors count 0. Good enough for table
// alignment; Ink does its own precise width math for wrapping.
export function cellWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if ((cp >= 0x0300 && cp <= 0x036f) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) {
      continue;
    }
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function truncateCell(text: string, max: number): string {
  if (cellWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const ch of text) {
    const w = cellWidth(ch);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD_RE = /\*\*([^*\n]+)\*\*|__([^_\n]+)__/g;
const STRIKE_RE = /~~([^~\n]+)~~/g;
const STAR_ITALIC_RE = /\*([^*\n]+)\*/g;
// _emphasis_ only at word boundaries so snake_case stays literal.
const UNDERSCORE_ITALIC_RE = /(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g;

// Inline styles. Code spans are split out first so their contents are never
// re-parsed for emphasis markers.
export function renderInline(text: string, base = ""): string {
  return text
    .split(/`([^`\n]+)`/)
    .map((segment, index) => {
      // Odd segments are code-span contents.
      if (index % 2 === 1) return yellow(segment, base);
      return segment
        .replace(IMAGE_RE, (_m, alt: string) => dim(`[image: ${alt}]`, base))
        .replace(
          LINK_RE,
          (_m, label: string, url: string) => `${underline(label, base)}${dim(` (${url})`, base)}`,
        )
        .replace(BOLD_RE, (_m, star: string, under: string) => bold(star ?? under, base))
        .replace(STRIKE_RE, (_m, t: string) => strike(t, base))
        .replace(STAR_ITALIC_RE, (_m, t: string) => italic(t, base))
        .replace(UNDERSCORE_ITALIC_RE, (_m, pre: string, t: string) => pre + italic(t, base));
    })
    .join("");
}

const HEADING_RE = /^#{1,6}\s+(.*)$/;
const HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const FENCE_RE = /^\s{0,3}(```+|~~~+)/;
const TABLE_SEPARATOR_CELL_RE = /^:?-{3,}:?$/;

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return (
    cells !== null &&
    cells.length > 0 &&
    cells.every((cell) => TABLE_SEPARATOR_CELL_RE.test(cell.trim()))
  );
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const stripped = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return stripped.split("|").map((cell) => cell.trim());
}

const MIN_COLUMN_WIDTH = 4;

function renderTable(lines: string[], base: string, maxWidth: number): string[] {
  const rows: string[][] = [];
  for (const line of lines) {
    const cells = splitTableRow(line);
    if (cells) rows.push(cells);
  }
  if (rows.length < 2) return lines;
  const columnCount = Math.max(...rows.map((row) => row.length));
  // Natural widths first: cells are only truncated when the whole grid would
  // exceed the terminal — then the widest column shrinks one cell at a time.
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(1, ...rows.map((row) => cellWidth(row[column] ?? ""))),
  );
  // 2 for the indent, 3 per " │ " joiner.
  const totalWidth = () =>
    2 + widths.reduce((sum, width) => sum + width, 0) + 3 * (columnCount - 1);
  while (totalWidth() > maxWidth) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] === undefined || widths[widest] <= MIN_COLUMN_WIDTH) break;
    widths[widest] -= 1;
  }
  for (const row of rows) {
    for (let column = 0; column < row.length; column++) {
      row[column] = truncateCell(row[column] ?? "", widths[column] ?? 1);
    }
  }
  // Widths come from the raw cell text; padding is appended after styling so
  // ANSI bytes never skew the alignment.
  const joiner = ` ${dim("│", base)} `;
  const formatRow = (row: string[], style: (cell: string) => string) =>
    `  ${widths
      .map((width, column) => {
        const raw = row[column] ?? "";
        return style(raw) + " ".repeat(Math.max(0, width - cellWidth(raw)));
      })
      .join(joiner)
      .trimEnd()}`;
  const separator = dim(`  ${widths.map((width) => "─".repeat(width)).join("─┼─")}`, base);
  const [header, , ...body] = rows as [string[], string[], ...string[][]];
  return [
    formatRow(header, (cell) => bold(cell, base)),
    separator,
    ...body.flatMap((row, index) => {
      const line = formatRow(row, (cell) => renderInline(cell, base));
      return index < body.length - 1 ? [line, separator] : [line];
    }),
  ];
}

// Longest leading run of lines that ends at a markdown block boundary: not
// inside a fenced code block, and not inside a run of pipe lines (a table, or
// a would-be table whose separator is still streaming). The REPL commits
// streamed text to static history in chunks and each chunk is rendered
// standalone, so a chunk must never end mid-construct — a table split in two
// would render its tail as raw pipe text.
export function committableLineCount(lines: string[]): number {
  let inFence = false;
  let safe = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) inFence = !inFence;
    const isPipe = line.includes("|");
    // For the last line the next line is still streaming, so assume the worst.
    const nextIsPipe = i + 1 >= lines.length || (lines[i + 1] ?? "").includes("|");
    if (!inFence && !(isPipe && nextIsPipe)) safe = i + 1;
  }
  return safe;
}

// Renders a markdown block into an ANSI-styled string. `base` re-opens the
// surrounding text color after each styled span (see module docstring).
// `maxWidth` caps rendered table grids so rows never wrap in the terminal.
export function renderMarkdown(text: string, base = "", maxWidth = 80): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (inFence) {
      if (FENCE_RE.test(line)) {
        inFence = false;
      } else {
        out.push(`${dim("  ▎", base)}${line}`);
      }
      continue;
    }
    const fence = FENCE_RE.exec(line);
    if (fence) {
      inFence = true;
      const lang = line
        .trim()
        .slice(fence[1]?.length ?? 0)
        .trim();
      if (lang) out.push(dim(`  ▎ ${lang}`, base));
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      out.push(cyanBold(heading[1] ?? "", base));
      continue;
    }
    if (HR_RE.test(line)) {
      out.push(dim("  ────────", base));
      continue;
    }
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      out.push(`${dim("  ▎", base)}${italic(renderInline(quote[1] ?? "", base), base)}`);
      continue;
    }
    // Pipe table: a header row followed by a --- separator row.
    const headerCells = splitTableRow(line);
    if (headerCells && i + 1 < lines.length && isTableSeparator(lines[i + 1] ?? "")) {
      const block = [line];
      let j = i + 1;
      while (j < lines.length && splitTableRow(lines[j] ?? "") !== null) {
        block.push(lines[j] ?? "");
        j += 1;
      }
      out.push(...renderTable(block, base, maxWidth));
      i = j - 1;
      continue;
    }
    out.push(renderInline(line, base));
  }
  return out.join("\n");
}
