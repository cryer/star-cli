// Byte-level liveness for streamed responses. The idle watchdog in stream.ts
// only sees parsed stream parts, but relays fronting slow upstreams often
// send SSE heartbeat comments (": keep-alive") while buffering — the AI SDK
// parses and swallows those, so at the part level a healthy-but-slow stream
// looks dead and gets cut mid-generation. Wrapping fetch here timestamps
// every raw body chunk per request (keyed by the request's AbortSignal,
// which the AI SDK forwards from streamText's abortSignal), letting the
// watchdog tell "bytes still flowing" apart from "connection truly silent".

export interface StreamActivity {
  // Timestamp of the last raw body chunk (or response headers, initially).
  lastChunkAt: number;
}

const trackers = new WeakMap<AbortSignal, StreamActivity>();

export function streamActivity(signal: AbortSignal): StreamActivity | undefined {
  return trackers.get(signal);
}

// Registers a tracker for a signal. Production code should never call this —
// wrapFetchWithActivity registers on its own; this exists so tests can fake
// byte-level liveness for a streamChat call without going through fetch.
export function registerStreamActivity(signal: AbortSignal): StreamActivity {
  const tracker: StreamActivity = { lastChunkAt: Date.now() };
  trackers.set(signal, tracker);
  return tracker;
}

export function wrapFetchWithActivity(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    if (!signal || !response.body) return response;
    const tracker: StreamActivity = { lastChunkAt: Date.now() };
    trackers.set(signal, tracker);
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            return;
          }
          tracker.lastChunkAt = Date.now();
          controller.enqueue(value);
        } catch (error) {
          controller.error(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
