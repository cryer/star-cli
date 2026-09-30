import { describe, expect, it } from "vitest";
import { SseNormalizeTransform, createSseNormalizingFetch } from "../src/llm/sse-normalize";

async function runTransform(chunks: string[]): Promise<string> {
  const source = new ReadableStream<string>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const out = source.pipeThrough(new SseNormalizeTransform());
  let result = "";
  const reader = out.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return result;
    result += value;
  }
}

describe("SseNormalizeTransform", () => {
  it("passes a well-formed stream through", async () => {
    const input = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    expect(await runTransform([input])).toBe(input);
  });

  it("splits a batched data payload into one event per object", async () => {
    // The relay shape that broke the SDK: several compact JSON objects in a
    // single data field (only the first line carries the "data:" prefix).
    const input = 'data: {"a":1}\n{"b":2}\n{"c":3}\n\n';
    expect(await runTransform([input])).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n');
  });

  it("splits batched payloads that repeat the data: prefix", async () => {
    const input = 'data: {"a":1}\ndata: {"b":2}\n\n';
    expect(await runTransform([input])).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  it("handles events split across chunks mid-line", async () => {
    const chunks = ['data: {"a', '":1}\n{"b', '":2}\n\nda', "ta: [DONE]\n\n"];
    expect(await runTransform(chunks)).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n');
  });

  it("tolerates CRLF line endings", async () => {
    const input = 'data: {"a":1}\r\n{"b":2}\r\n\r\n';
    expect(await runTransform([input])).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  it("flushes a trailing event without a final blank line", async () => {
    expect(await runTransform(['data: {"a":1}\n{"b":2}'])).toBe(
      'data: {"a":1}\n\ndata: {"b":2}\n\n',
    );
  });

  it("splits a JSON payload glued to the next event line without a newline", async () => {
    // Observed on a relay fronting gpt-6-astra: a complete event followed
    // directly by the next event's `event:` line inside one data payload.
    const input = 'data: {"a":1}event: response.output_text.delta.\ndata: {"b":2}\n\n';
    expect(await runTransform([input])).toBe(
      'data: {"a":1}\n\nevent: response.output_text.delta.\ndata: {"b":2}\n\n',
    );
  });

  it("splits JSON objects glued without any separator", async () => {
    expect(await runTransform(['data: {"a":1}{"b":2}\n\n'])).toBe(
      'data: {"a":1}\n\ndata: {"b":2}\n\n',
    );
  });

  it("splits a JSON payload glued to a nested data: field", async () => {
    expect(await runTransform(['data: {"a":1}data: {"b":2}\n\n'])).toBe(
      'data: {"a":1}\n\ndata: {"b":2}\n\n',
    );
  });

  it("does not split on brace-looking text inside JSON string values", async () => {
    // The glue marker '}event:' inside a string value must not end the
    // object — only string-aware brace counting gets this right.
    const input = 'data: {"a":"}event: fake"}\n\ndata: [DONE]\n\n';
    expect(await runTransform([input])).toBe(input);
  });
});

describe("createSseNormalizingFetch", () => {
  function fakeFetch(contentType: string, body: string): typeof fetch {
    return async () =>
      new Response(new TextEncoder().encode(body), {
        status: 200,
        headers: { "content-type": contentType },
      });
  }

  it("normalizes SSE responses", async () => {
    const wrapped = createSseNormalizingFetch(
      fakeFetch("text/event-stream", 'data: {"a":1}\n{"b":2}\n\n'),
    );
    const response = await wrapped("https://example.com/v1/responses", {});
    expect(await response.text()).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  it("drops content-length and content-encoding from rewritten SSE responses", async () => {
    // The rewritten body differs in length and encoding from the original;
    // keeping the old headers would corrupt reads downstream.
    const base = (async () =>
      new Response('data: {"a":1}\n{"b":2}\n\n', {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-length": "26",
          "content-encoding": "gzip",
        },
      })) as typeof fetch;
    const wrapped = createSseNormalizingFetch(base);
    const response = await wrapped("https://example.com/v1/responses", {});
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(await response.text()).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
  });

  it("leaves non-SSE responses untouched", async () => {
    const wrapped = createSseNormalizingFetch(fakeFetch("application/json", '{"error":"nope"}'));
    const response = await wrapped("https://example.com/v1/responses", {});
    expect(await response.text()).toBe('{"error":"nope"}');
  });
});
