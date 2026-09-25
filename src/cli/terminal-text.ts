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
