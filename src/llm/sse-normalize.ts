// Some relays (this one fronts the OpenAI Responses API behind
// /v1/responses) batch several compact JSON events into ONE SSE data
// payload instead of one event per `data:` line — either as bare
// continuation lines, or glued together with the next event's
// `event:`/`data:` line and no newline at all. The AI SDK's SSE parser
// JSON-parses each data payload whole, so a batched payload fails with
// "Unexpected non-whitespace character after JSON". Codex and opencode
// parse events line-by-line and tolerate this. Since we stay on the AI SDK,
// normalize the wire format at the fetch layer: split every batched data
// payload back into one event per JSON object (the split point is the true
// end of each object, found by string-aware brace counting).
//
// The output is NOT byte-equivalent to the input: every event is re-emitted
// as `data: <payload>` followed by a blank line, so CRLF endings become LF
// and a `data:{...}` line gains the space after the colon. Lines are split
// on \n only — a stream using bare \r as its line terminator is not
// supported.

// Returns [json, rest] when text starts with a complete JSON object,
// splitting at its true end (string- and escape-aware, so a "}" inside a
// string value never counts), or null when the object is incomplete or the
// text is not an object. Relays sometimes glue the next event's `event:` /
// `data:` line onto a JSON payload without any newline — brace counting is
// the only reliable split point.
function splitJsonPrefix(text: string): [string, string] | null {
  if (!text.startsWith("{")) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return [text.slice(0, i + 1), text.slice(i + 1).trimStart()];
    }
  }
  return null;
}

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

    // Emits a data payload, splitting off any events glued to it without a
    // newline (`{...}event: foo`, `{...}data: {...}`, `{...}{...}`): each
    // complete JSON object becomes its own event and the remainder is
    // reprocessed. An incomplete or non-JSON payload keeps the original
    // assembly behavior (held as pending until the event closes).
    const emitPayload = (payload: string, controller: TransformStreamDefaultController<string>) => {
      let rest = payload;
      for (;;) {
        const split = splitJsonPrefix(rest);
        if (!split) {
          pending = rest;
          return;
        }
        const [json, tail] = split;
        if (tail === "") {
          pending = json;
          return;
        }
        controller.enqueue(`data: ${json}\n\n`);
        if (tail.startsWith("data:")) {
          rest = tail.slice(5).replace(/^ /, "");
          continue;
        }
        if (tail.startsWith("{")) {
          rest = tail;
          continue;
        }
        // A glued `event:`/`id:`/comment line: emit it as its own line —
        // harmless to the SDK parser, which reads the event type from the
        // JSON payload itself.
        controller.enqueue(`${tail}\n`);
        return;
      }
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
        emitPayload(line.slice(5).replace(/^ /, ""), controller);
        return;
      }
      if (line.startsWith("{") && pending !== null) {
        // A continuation line of a batched payload: the previous object is
        // complete, so it becomes its own event and this line opens the next.
        flushPending(controller);
        emitPayload(line, controller);
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
