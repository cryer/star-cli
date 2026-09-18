import { afterEach, describe, expect, it, vi } from "vitest";
import { parseResults, webSearchTool } from "../src/tools/web/search";

const DDG_HTML = `<!DOCTYPE html>
<html>
<head><title>test query at DuckDuckGo</title></head>
<body>
<div class="results">
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fa%3D1%26b%3D2&amp;rut=deadbeef">Example &amp; Page</a>
      </h2>
      <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage">A &lt;b&gt;snippet&lt;/b&gt; with <b>bold</b> text.</a>
      <span class="result__url">example.com/page</span>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://direct.example.org/">Direct Link</a>
      </h2>
      <div class="result__snippet">Second result snippet &#65;&#x42;.</div>
    </div>
  </div>
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="https://nosnippet.example.net/">No Snippet Result</a>
      </h2>
    </div>
  </div>
</div>
</body>
</html>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseResults", () => {
  it("extracts title, decoded URL and snippet from DuckDuckGo HTML", () => {
    const results = parseResults(DDG_HTML);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({
      title: "Example & Page",
      url: "https://example.com/page?a=1&b=2",
      snippet: "A <b>snippet</b> with bold text.",
    });
    expect(results[1]).toEqual({
      title: "Direct Link",
      url: "https://direct.example.org/",
      snippet: "Second result snippet AB.",
    });
    expect(results[2]).toEqual({
      title: "No Snippet Result",
      url: "https://nosnippet.example.net/",
      snippet: "",
    });
  });

  it("returns an empty array when there are no results", () => {
    expect(parseResults("<html><body><div>No results found.</div></body></html>")).toEqual([]);
    expect(parseResults("")).toEqual([]);
  });

  it("tolerates malformed HTML without throwing", () => {
    const malformed = `<a class="result__a" href="https://ok.example/">Good One</a>
      <a class="result__a">No Href</a>
      <a class="result__a" href="https://unclosed.example/">Unclosed
      <div class="result__snippet">never closed either`;
    const results = parseResults(malformed);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]).toEqual({
      title: "Good One",
      url: "https://ok.example/",
      snippet: "",
    });
  });
});

describe("web_search", () => {
  it("returns a numbered list of results", async () => {
    const calls: { url: string; ua?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, ua: headers.get("user-agent") ?? undefined });
      return new Response(DDG_HTML, { status: 200, headers: { "content-type": "text/html" } });
    });
    const res = await webSearchTool.execute({ query: "hello world" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("1. Example & Page");
    expect(res.content).toContain("https://example.com/page?a=1&b=2");
    expect(res.content).toContain("2. Direct Link");
    expect(res.content).toContain("3. No Snippet Result");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://html.duckduckgo.com/html/?q=hello%20world");
    expect(calls[0]?.ua).toContain("Mozilla");
  });

  it("respects maxResults", async () => {
    vi.stubGlobal("fetch", async () => new Response(DDG_HTML, { status: 200 }));
    const res = await webSearchTool.execute({ query: "q", maxResults: 2 }, { cwd: process.cwd() });
    expect(res.content).toContain("1. Example & Page");
    expect(res.content).toContain("2. Direct Link");
    expect(res.content).not.toContain("3. No Snippet Result");
  });

  it("returns isError on timeout", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("timed out");
  });

  it("returns isError on network failure", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("search request failed");
  });

  it("returns isError on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 403");
  });

  it("returns isError when no results can be parsed", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<html><body>captcha</body></html>", { status: 200 }),
    );
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no results");
  });
});
