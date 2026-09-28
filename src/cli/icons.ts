// Decorative icons with a terminal-capability fallback.
//
// Emoji glyphs are double-width only on terminals with real emoji support.
// On GBK/CJK consoles and mintty without emoji fonts they render as narrow
// single-cell fallback glyphs while Ink's width math (string-width) counts
// them double — a line near the wrap boundary then occupies fewer terminal
// rows than Ink counted, the frame erase overshoots, and every spinner tick
// leaves the display scrambled (the "scroll spam" regression). Emoji icons
// are therefore enabled only where the terminal is known to render them
// double-width; elsewhere a plain single-width symbol set is used.
// STAR_ICONS=emoji|plain overrides the detection.
//
// Plain-set rule: every glyph must have string-width 1, which means no
// Emoji-property characters at all — string-width counts even text-presentation
// emoji candidates (✔, ☰, ⚙, ↗…) as width 2. Stick to neutral/ambiguous
// symbols (✦ ❯ ◦ ▸ ‣ ✧ ✎ ※ ◉ ≡ × § ¶ …).

export type IconMode = "emoji" | "plain";

const EMOJI_TERM_PROGRAMS = new Set([
  "vscode",
  "WezTerm",
  "iTerm.app",
  "Apple_Terminal",
  "ghostty",
  "kitty",
  "Hyper",
  "WarpTerminal",
]);

export function resolveIconMode(env: NodeJS.ProcessEnv = process.env): IconMode {
  const override = env.STAR_ICONS;
  if (override === "emoji" || override === "plain") return override;
  if (env.WT_SESSION) return "emoji"; // Windows Terminal
  if (EMOJI_TERM_PROGRAMS.has(env.TERM_PROGRAM ?? "")) return "emoji";
  const term = env.TERM ?? "";
  if (term.includes("kitty") || term.includes("alacritty")) return "emoji";
  return "plain";
}

export const EMOJI_TOOL_ICONS: Record<string, string> = {
  bash: "💻",
  read_file: "📄",
  write_file: "📝",
  edit_file: "✏️",
  glob: "📂",
  grep: "🔍",
  web_search: "🔎",
  web_fetch: "🌐",
  todo_write: "📋",
  todo_read: "📋",
  task_list: "🧵",
  task_output: "🧵",
  task_kill: "🛑",
  subagent: "🤖",
  skill: "✨",
  remember: "🧠",
};

export const PLAIN_TOOL_ICONS: Record<string, string> = {
  bash: "$",
  read_file: "≡",
  write_file: "+",
  edit_file: "✎",
  glob: "*",
  grep: "/",
  web_search: "?",
  web_fetch: "⇓",
  todo_write: "‣",
  todo_read: "‣",
  task_list: "¶",
  task_output: "¶",
  task_kill: "×",
  subagent: "◉",
  skill: "✧",
  remember: "※",
};

const iconMode = resolveIconMode();

export function toolIcon(name: string): string {
  const map = iconMode === "emoji" ? EMOJI_TOOL_ICONS : PLAIN_TOOL_ICONS;
  return map[name] ?? (iconMode === "emoji" ? "🔧" : "▸");
}

// 💭 / ✧ — thinking spinner label and the collapsed thought summary.
export const thinkingIcon = iconMode === "emoji" ? "💭" : "✧";

// 📁 prefix for the status-bar cwd; plain mode keeps the bare path.
export const folderIcon = iconMode === "emoji" ? "📁 " : "";
