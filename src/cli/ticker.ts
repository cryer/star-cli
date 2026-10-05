export const TICK_MS = 100;

export interface FlushState {
  streamed: string;
  reasoning: string;
}

// Returns the next flush state, or null when nothing changed since prev,
// so callers can skip the state update (and the full Ink re-render) entirely.
export function nextFlush(prev: FlushState, next: FlushState): FlushState | null {
  if (prev.streamed === next.streamed && prev.reasoning === next.reasoning) return null;
  return next;
}

// Shared 100ms interval helper. The Repl's stream flush and the
// ThinkingIndicator's spinner each run their own instance, so the spinner's
// per-frame re-render stays inside the indicator instead of touching the
// Repl root. Returns a stop function; the callback receives the tick count.
export function startTicker(onTick: (tick: number) => void, intervalMs = TICK_MS): () => void {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    onTick(tick);
  }, intervalMs);
  return () => clearInterval(timer);
}
