import path from "node:path";
import { resolveIconMode } from "./icons";

// Terminal tab/window title via OSC 0: a braille spinner runs in the title
// while a turn is in flight and a bell glyph replaces it when the turn
// completes, so a user on another tab or desktop can see the agent is busy /
// finished without watching the window. The audible bell is a separate
// mechanism (notify.ts, gated by the notifyBell config).

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TITLE_INTERVAL_MS = 120;

export interface TerminalTitleDeps {
  write?: (text: string) => void;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

// A hostile cwd must not break out of the OSC sequence (\x07 terminates it
// early, \x1b injects new sequences).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

export function setTerminalTitle(title: string, deps: TerminalTitleDeps = {}): void {
  const isTTY = deps.isTTY ?? Boolean(process.stdout.isTTY);
  if (!isTTY) return;
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  write(`\x1b]0;${title.replace(CONTROL_CHARS, "")}\x07`);
}

export class TerminalTitle {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;

  private constructor(
    private readonly base: string,
    private readonly deps: TerminalTitleDeps,
  ) {}

  static forCwd(cwd: string, deps: TerminalTitleDeps = {}): TerminalTitle {
    return new TerminalTitle(`star-cli — ${path.basename(cwd) || cwd}`, deps);
  }

  start(): void {
    if (this.timer) return;
    this.render(SPINNER_FRAMES[this.frame] ?? "⠋");
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.render(SPINNER_FRAMES[this.frame] ?? "⠋");
    }, TITLE_INTERVAL_MS);
    this.timer.unref();
  }

  // "done" leaves a bell glyph in the title until the next turn starts;
  // "idle" (interrupt, unmount) restores the bare title.
  stop(kind: "done" | "idle" = "done"): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.frame = 0;
    this.render(kind === "done" ? (resolveIconMode(this.deps.env) === "emoji" ? "🔔" : "!") : "");
  }

  private render(prefix: string): void {
    setTerminalTitle(prefix ? `${prefix} ${this.base}` : this.base, this.deps);
  }
}
