export const DOUBLE_ESC_WINDOW_MS = 600;

// Two Esc presses within the window (while idle) trigger edit-last-message.
export function isDoubleEscape(
  previous: number | null,
  now: number,
  windowMs: number = DOUBLE_ESC_WINDOW_MS,
): boolean {
  return previous !== null && now - previous <= windowMs;
}
