import { describe, expect, it } from "vitest";
import { type StreamEvent, toStreamErrorInfo } from "../src/core/events";
import { isRetryableStreamError, summarizeStreamError } from "../src/llm/retry";

function apiError(
  message: string,
  init: {
    statusCode?: number;
    isRetryable?: boolean;
    responseBody?: string;
    responseHeaders?: Record<string, string>;
  },
): Error {
  const error = new Error(message);
  error.name = "AI_APICallError";
  Object.assign(error, init);
  return error;
}

describe("toStreamErrorInfo", () => {
  it("keeps only name and message for a plain Error", () => {
    expect(toStreamErrorInfo(new Error("boom"))).toEqual({ name: "Error", message: "boom" });
    const syntax = toStreamErrorInfo(new SyntaxError("bad json"));
    expect(syntax).toEqual({ name: "SyntaxError", message: "bad json" });
  });

  it("preserves every property the retry policy classifies on", () => {
    const info = toStreamErrorInfo(
      apiError("limited", {
        statusCode: 429,
        isRetryable: true,
        responseBody: '{"error":"rate limit"}',
        responseHeaders: { "retry-after": "3" },
      }),
    );
    expect(info).toEqual({
      name: "AI_APICallError",
      message: "limited",
      statusCode: 429,
      isRetryable: true,
      responseBody: '{"error":"rate limit"}',
      responseHeaders: { "retry-after": "3" },
    });
  });

  it("flattens a network errno on the error itself", () => {
    const hangUp = new Error("socket hang up");
    Object.assign(hangUp, { code: "ECONNRESET" });
    const info = toStreamErrorInfo(hangUp);
    expect(info.code).toBe("ECONNRESET");
    expect(isRetryableStreamError(info)).toBe(true);
  });

  it("flattens the cause chain's errno to causeCode", () => {
    // Node's fetch reports transport failures as TypeError("fetch failed")
    // with the real errno at cause.code — one level, like the old classifier.
    const fetchFailed = new TypeError("fetch failed");
    Object.assign(fetchFailed, { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    const info = toStreamErrorInfo(fetchFailed);
    expect(info).toEqual({
      name: "TypeError",
      message: "fetch failed",
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
    });
    expect(isRetryableStreamError(info)).toBe(true);
  });

  it("drops unusable extras instead of carrying them", () => {
    const error = new Error("boom");
    Object.assign(error, {
      statusCode: "500",
      isRetryable: false,
      code: 42,
      cause: "not-an-object",
      responseBody: "",
      responseHeaders: { "x-count": 7, "retry-after": "2" },
    });
    const info = toStreamErrorInfo(error);
    expect(info).toEqual({
      name: "Error",
      message: "boom",
      responseHeaders: { "retry-after": "2" },
    });
  });

  it("wraps non-Error values like the old new Error(String(value)) path", () => {
    expect(toStreamErrorInfo("boom")).toEqual({ name: "Error", message: "boom" });
    expect(toStreamErrorInfo(42)).toEqual({ name: "Error", message: "42" });
    expect(toStreamErrorInfo(undefined)).toEqual({ name: "Error", message: "undefined" });
    expect(toStreamErrorInfo(null)).toEqual({ name: "Error", message: "null" });
  });

  it("unwraps a relay's parsed error payload object instead of printing [object Object]", () => {
    // A 200 stream carrying an error chunk surfaces the parsed payload as a
    // plain object, not an Error instance.
    const info = toStreamErrorInfo({
      message: "The engine is currently overloaded, please try again later",
      type: "engine_overloaded_error",
    });
    expect(info).toEqual({
      name: "engine_overloaded_error",
      message: "The engine is currently overloaded, please try again later",
    });
    // Statusless, but the message names an unambiguous transient condition.
    expect(isRetryableStreamError(info)).toBe(true);
  });

  it("reads status/code fields off object payloads and JSON-serializes messageless ones", () => {
    const info = toStreamErrorInfo({ status: 503, code: "upstream_down" });
    expect(info.statusCode).toBe(503);
    expect(info.code).toBe("upstream_down");
    expect(info.message).toBe('{"status":503,"code":"upstream_down"}');
    expect(info.name).toBe("Error");
  });
});

describe("error event serialization", () => {
  it("survives a JSON round-trip with classification and summary unchanged", () => {
    const event: StreamEvent = {
      type: "error",
      error: toStreamErrorInfo(
        apiError("Bad Request", {
          statusCode: 400,
          responseBody: '{"error": "provider returned error: upstream timeout"}',
          responseHeaders: { "retry-after": "5" },
        }),
      ),
    };
    const restored = JSON.parse(JSON.stringify(event)) as StreamEvent & { type: "error" };
    expect(restored).toEqual(event);
    expect(isRetryableStreamError(restored.error)).toBe(isRetryableStreamError(event.error));
    expect(summarizeStreamError(restored.error)).toBe(summarizeStreamError(event.error));
  });

  it('serializes the failure details instead of the Error instance\'s "{}"', () => {
    const event: StreamEvent = {
      type: "error",
      error: toStreamErrorInfo(new Error("relay down")),
    };
    const json = JSON.stringify(event);
    expect(json).toContain("relay down");
    expect(JSON.parse(json)).toEqual({
      type: "error",
      error: { name: "Error", message: "relay down" },
    });
  });
});
