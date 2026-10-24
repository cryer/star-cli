// Model/tool-controlled text lands in Ink's live region, where each frame is
// erased and redrawn based on Ink's own width math. string-width reports \t
// as width 0 while real terminals expand it to the next tab stop, and raw
// control bytes (\r, ESC, …) move the cursor — both make the on-screen frame
// taller than Ink counted, so the erase misses lines and every spinner tick
// leaves a stale duplicate behind (the "scroll spam" bug). Normalize such
// text before it reaches the terminal: tabs become two spaces, all other C0
// controls except \n are dropped. Display-only — persisted messages and tool
// results keep the original bytes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the whole point
const UNSAFE_CHARS = /[\x00-\x09\x0b-\x1f\x7f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the whole point
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;
const TABS = /\t/g;

export function toTerminalSafe(text: string): string {
  if (!UNSAFE_CHARS.test(text)) return text;
  return text.replace(TABS, "  ").replace(CONTROL_CHARS, "");
}

// Display-width helpers for layout budgeting (status bar truncation). Ink does
// the precise string-width math at render; these only need a conservative
// approximation: East Asian Wide/Fullwidth and emoji count as two cells.
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK radicals … Yi syllables
  [0xa960, 0xa97c], // Hangul Jamo Extended-B
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe52], // CJK compatibility forms
  [0xfe54, 0xfe66], // small form variants
  [0xfe68, 0xfe6b],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff], // supplemental emoji
  [0x20000, 0x3fffd], // CJK extension planes
];

function isWideChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return WIDE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWideChar(ch) ? 2 : 1;
  return width;
}

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (displayWidth(text) <= maxWidth) return text;
  const limit = Math.max(0, maxWidth - 1);
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = isWideChar(ch) ? 2 : 1;
    if (width + w > limit) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}
