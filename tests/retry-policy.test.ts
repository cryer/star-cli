import { describe, expect, it } from "vitest";
import { responseBodyOf } from "../src/core/http-error";
import {
  MAX_RETRY_DELAY_MS,
  computeRetryDelayMs,
  isRetryableStreamError,
  retryAfterDelayMs,
  summarizeStreamError,
} from "../src/llm/retry";

function apiError(
  message: string,
  init: { statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string> },
): Error {
  const error = new Error(message);
  error.name = "AI_APICallError";
  Object.assign(error, init);
  return error;
}

describe("isRetryableStreamError", () => {
  it("never retries client/validation error names", () => {
    const error = new Error("unknown tool");
    error.name = "AI_NoSuchToolError";
    expect(isRetryableStreamError(error)).toBe(false);
  });

  it("never retries SDK validation/parse errors, however transient they sound", () => {
    // A relay answering with a malformed payload fails identically on resend.
    for (const name of ["AI_TypeValidationError", "AI_JSONParseError"]) {
      const error = new Error("overloaded: service unavailable");
      error.name = name;
      expect(isRetryableStreamError(error)).toBe(false);
    }
  });

  it("does not retry 501 Not Implemented", () => {
    expect(isRetryableStreamError(apiError("Not Implemented", { statusCode: 501 }))).toBe(false);
  });

  it("still retries a 501 whose body reports a transient upstream failure", () => {
    // Relays mislabel gateway failures; the body is the only honest signal.
    expect(
      isRetryableStreamError(
        apiError("Not Implemented", {
          statusCode: 501,
          responseBody: '{"error":"upstream connect timeout"}',
        }),
      ),
    ).toBe(true);
  });

  it("retries rate limits and server errors by status", () => {
    expect(isRetryableStreamError(apiError("limited", { statusCode: 429 }))).toBe(true);
    expect(isRetryableStreamError(apiError("oops", { statusCode: 500 }))).toBe(true);
    expect(isRetryableStreamError(apiError("bad gateway", { statusCode: 502 }))).toBe(true);
  });

  it("does not retry a plain 4xx", () => {
    expect(isRetryableStreamError(apiError("Incorrect API key", { statusCode: 401 }))).toBe(false);
    expect(isRetryableStreamError(apiError("model not found", { statusCode: 404 }))).toBe(false);
    expect(isRetryableStreamError(apiError("invalid schema", { statusCode: 400 }))).toBe(false);
  });

  it("retries a 4xx whose message or body reports a transient failure", () => {
    // Cloudflare-style rate-limit page surfaced by a relay as a 403.
    expect(
      isRetryableStreamError(
        apiError("Forbidden: you are being rate limited", { statusCode: 403 }),
      ),
    ).toBe(true);
    // Relay wrapping an upstream failure in a 400.
    expect(
      isRetryableStreamError(
        apiError("Bad Request", {
          statusCode: 400,
          responseBody: '{"error":"provider returned error: upstream connect timeout"}',
        }),
      ),
    ).toBe(true);
    expect(
      isRetryableStreamError(
        apiError("Bad Request", { statusCode: 400, responseBody: "service unavailable" }),
      ),
    ).toBe(true);
  });

  it("retries network failures without a status code", () => {
    expect(isRetryableStreamError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableStreamError(new Error("fetch failed"))).toBe(true);
  });

  it("trusts the SDK's own retryable classification", () => {
    const error = apiError("teapot", { statusCode: 418 });
    (error as unknown as { isRetryable: boolean }).isRetryable = true;
    expect(isRetryableStreamError(error)).toBe(true);
  });
});

describe("retryAfterDelayMs", () => {
  it("parses retry-after-ms", () => {
    expect(
      retryAfterDelayMs(apiError("limited", { responseHeaders: { "retry-after-ms": "2500" } })),
    ).toBe(2500);
  });

  it("parses retry-after in seconds", () => {
    expect(
      retryAfterDelayMs(apiError("limited", { responseHeaders: { "retry-after": "3" } })),
    ).toBe(3000);
  });

  it("parses retry-after as an HTTP date", () => {
    const when = new Date(Date.now() + 10_000).toUTCString();
    const delay = retryAfterDelayMs(
      apiError("limited", { responseHeaders: { "retry-after": when } }),
    );
    expect(delay).toBeGreaterThan(5000);
    expect(delay).toBeLessThanOrEqual(10_000);
  });

  it("ignores missing or unparsable headers", () => {
    expect(retryAfterDelayMs(new Error("boom"))).toBeUndefined();
    expect(
      retryAfterDelayMs(apiError("boom", { responseHeaders: { "retry-after": "not-a-date" } })),
    ).toBeUndefined();
  });
});

describe("computeRetryDelayMs", () => {
  it("grows exponentially from the base delay", () => {
    expect(computeRetryDelayMs(0, 1000, null, 0)).toBe(1000);
    expect(computeRetryDelayMs(1, 1000, null, 0)).toBe(2000);
    expect(computeRetryDelayMs(2, 1000, null, 0)).toBe(4000);
  });

  it("adds bounded jitter", () => {
    expect(computeRetryDelayMs(0, 1000, null, 1)).toBe(1250);
    for (let i = 0; i < 50; i++) {
      const delay = computeRetryDelayMs(1, 1000, null);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });

  it("caps the delay", () => {
    expect(computeRetryDelayMs(20, 1000, null, 1)).toBe(MAX_RETRY_DELAY_MS);
  });

  it("honors Retry-After hints, capped", () => {
    const hinted = apiError("limited", { responseHeaders: { "retry-after": "12" } });
    expect(computeRetryDelayMs(0, 1000, hinted)).toBe(12_000);
    const excessive = apiError("limited", { responseHeaders: { "retry-after": "600" } });
    expect(computeRetryDelayMs(0, 1000, excessive)).toBe(MAX_RETRY_DELAY_MS);
  });
});

describe("responseBodyOf", () => {
  it("returns the response body an API error carries", () => {
    expect(responseBodyOf(apiError("boom", { responseBody: '{"error":"x"}' }))).toBe(
      '{"error":"x"}',
    );
  });

  it("is undefined without a usable body", () => {
    expect(responseBodyOf(new Error("boom"))).toBeUndefined();
    expect(responseBodyOf(apiError("boom", { responseBody: "" }))).toBeUndefined();
    const nonString = new Error("boom");
    Object.assign(nonString, { responseBody: 42 });
    expect(responseBodyOf(nonString)).toBeUndefined();
  });
});

describe("summarizeStreamError", () => {
  it("adds the status and a response-body excerpt", () => {
    const summary = summarizeStreamError(
      apiError("Bad Request", {
        statusCode: 400,
        responseBody: '{"error": "provider returned error: upstream timeout"}',
      }),
    );
    expect(summary).toContain("Bad Request");
    expect(summary).toContain("(HTTP 400)");
    expect(summary).toContain("provider returned error");
  });

  it("stays plain when there is nothing to add", () => {
    expect(summarizeStreamError(new Error("socket hang up"))).toBe("socket hang up");
  });
});
