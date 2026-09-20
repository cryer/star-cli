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

// Single render ticker: one interval drives both stream flushes and the
// spinner frame. Returns a stop function; the callback receives the tick count.
export function startTicker(onTick: (tick: number) => void, intervalMs = TICK_MS): () => void {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    onTick(tick);
  }, intervalMs);
  return () => clearInterval(timer);
}
