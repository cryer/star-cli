export const TICK_MS = 100;
export const STREAM_FLUSH_MS = 40;

export function isMotionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.STAR_NO_MOTION === "1";
}

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

// The ThinkingIndicator owns its interval so spinner frames do not set state
// on the Repl root. Returns a stop function; the callback receives the tick count.
export function startTicker(onTick: (tick: number) => void, intervalMs = TICK_MS): () => void {
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    onTick(tick);
  }, intervalMs);
  return () => clearInterval(timer);
}

export interface FlushScheduler {
  request(): void;
  stop(): void;
}

export function createFlushScheduler(
  onFlush: () => void,
  intervalMs = STREAM_FLUSH_MS,
): FlushScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let stopped = false;
  const flush = () => {
    if (stopped) return;
    timer = null;
    lastFlush = Date.now();
    onFlush();
  };
  return {
    request() {
      if (stopped || timer) return;
      const wait = Math.max(0, intervalMs - (Date.now() - lastFlush));
      if (wait === 0) flush();
      else timer = setTimeout(flush, wait);
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
