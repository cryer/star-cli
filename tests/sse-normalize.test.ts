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

  it("leaves non-SSE responses untouched", async () => {
    const wrapped = createSseNormalizingFetch(fakeFetch("application/json", '{"error":"nope"}'));
    const response = await wrapped("https://example.com/v1/responses", {});
    expect(await response.text()).toBe('{"error":"nope"}');
  });
});
