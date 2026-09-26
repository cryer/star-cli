// Some relays (this one fronts the OpenAI Responses API behind
// /v1/responses) batch several compact JSON events into ONE SSE data
// payload instead of one event per `data:` line. The AI SDK's SSE parser
// JSON-parses each data payload whole, so a batched payload fails with
// "Unexpected non-whitespace character after JSON". Codex and opencode
// parse events line-by-line and tolerate this. Since we stay on the AI SDK,
// normalize the wire format at the fetch layer: split every batched data
// payload back into one event per JSON object.
//
// The output is NOT byte-equivalent to the input: every event is re-emitted
// as `data: <payload>` followed by a blank line, so CRLF endings become LF
// and a `data:{...}` line gains the space after the colon. Lines are split
// on \n only — a stream using bare \r as its line terminator is not
// supported.

// Splits SSE text into events at blank lines, then re-emits each data
// payload that holds multiple JSON objects as separate `data:` events.
// Streaming-safe: lines are buffered across chunks, and a trailing partial
// line is held until it completes or the stream ends.
export class SseNormalizeTransform extends TransformStream<string, string> {
  constructor() {
    let buffer = "";
    // Payload of the data field currently being assembled (without the
    // "data:" prefix), or null when no event is open.
    let pending: string | null = null;

    const flushPending = (controller: TransformStreamDefaultController<string>) => {
      if (pending === null) return;
      controller.enqueue(`data: ${pending}\n\n`);
      pending = null;
    };

    const handleLine = (raw: string, controller: TransformStreamDefaultController<string>) => {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (line === "") {
        flushPending(controller);
        return;
      }
      if (line.startsWith("data:")) {
        // A new data field closes any event already being assembled.
        flushPending(controller);
        pending = line.slice(5).replace(/^ /, "");
        return;
      }
      if (line.startsWith("{") && pending !== null) {
        // A continuation line of a batched payload: the previous object is
        // complete, so it becomes its own event and this line opens the next.
        flushPending(controller);
        pending = line;
        return;
      }
      // Comments, event:/id:/retry: fields, and anything else: pass through
      // as a standalone line once no data payload is open.
      flushPending(controller);
      controller.enqueue(`${line}\n`);
    };

    super({
      transform(chunk, controller) {
        buffer += chunk;
        let index = buffer.indexOf("\n");
        while (index !== -1) {
          handleLine(buffer.slice(0, index), controller);
          buffer = buffer.slice(index + 1);
          index = buffer.indexOf("\n");
        }
      },
      flush(controller) {
        if (buffer.length > 0) handleLine(buffer, controller);
        flushPending(controller);
      },
    });
  }
}

// Wraps a base fetch (default: global) so SSE responses are piped through
// SseNormalizeTransform; non-SSE responses (JSON errors, etc.) pass through
// untouched. Used for the openai-responses protocol only — chat-completions
// relays already emit one event per data line.
export function createSseNormalizingFetch(baseFetch: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) {
      return response;
    }
    const body = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new SseNormalizeTransform())
      .pipeThrough(new TextEncoderStream());
    // The rewritten body no longer matches the original bytes, so the old
    // content-length/content-encoding would lie about (and corrupt) it.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}
