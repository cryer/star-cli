import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBingResults, parseDdgLiteResults, webSearchTool } from "../src/tools/web/search";

const DDG_LITE_HTML = `<!DOCTYPE html>
<html><body>
<table class="results">
<tr>
  <td valign="top">1.&nbsp;</td>
  <td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2Fpage%3Fx%3D1&amp;rut=beef" class='result-link'>Lite &amp; Result</a></td>
</tr>
<tr>
  <td>&nbsp;</td>
  <td class='result-snippet'>Snippet from <b>lite</b> &lt;source&gt;.</td>
</tr>
<tr>
  <td>&nbsp;</td>
  <td><span class='link-text'>lite.example.com</span></td>
</tr>
<tr>
  <td valign="top">2.&nbsp;</td>
  <td><a rel="nofollow" href="https://direct-lite.example.org/" class="result-link">Direct Lite</a></td>
</tr>
<tr>
  <td>&nbsp;</td>
  <td class="result-snippet">Second lite snippet.</td>
</tr>
</table>
</body></html>`;

const BING_HTML = `<!DOCTYPE html>
<html><body>
<ol id="b_results">
<li class="b_algo"><h2><a href="https://bing.example.com/one" h="ID=SERP,5021.1">Bing One</a></h2><div class="b_caption"><p>First &amp; bing snippet.</p></div></li>
<li class="b_algo"><h2><a href="https://bing.example.com/two">Bing Two</a></h2><p>Second bing snippet.</p></li>
<li class="b_algo"><h2><a href="/relative/three">Relative Three</a></h2><p>Skipped, not absolute.</p></li>
</ol>
</body></html>`;

const CAPTCHA_HTML = "<html><body><div>Please prove you are human.</div></body></html>";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fallback source parsers", () => {
  it("parses DuckDuckGo Lite results into the unified shape", () => {
    const results = parseDdgLiteResults(DDG_LITE_HTML);
    expect(results).toEqual([
      {
        title: "Lite & Result",
        url: "https://lite.example.com/page?x=1",
        snippet: "Snippet from lite <source>.",
      },
      {
        title: "Direct Lite",
        url: "https://direct-lite.example.org/",
        snippet: "Second lite snippet.",
      },
    ]);
  });

  it("parses Bing results into the unified shape and skips non-http hrefs", () => {
    const results = parseBingResults(BING_HTML);
    expect(results).toEqual([
      {
        title: "Bing One",
        url: "https://bing.example.com/one",
        snippet: "First & bing snippet.",
      },
      {
        title: "Bing Two",
        url: "https://bing.example.com/two",
        snippet: "Second bing snippet.",
      },
    ]);
  });
});

describe("web_search fallbacks", () => {
  it("falls back to DuckDuckGo Lite when the primary source fails", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://html.duckduckgo.com/")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      if (url.startsWith("https://lite.duckduckgo.com/")) {
        return new Response(DDG_LITE_HTML, { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const res = await webSearchTool.execute({ query: "hello world" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("1. Lite & Result");
    expect(res.content).toContain("https://lite.example.com/page?x=1");
    expect(res.content).toContain("2. Direct Lite");
    expect(calls).toEqual([
      "https://html.duckduckgo.com/html/?q=hello%20world",
      "https://lite.duckduckgo.com/lite/?q=hello%20world",
    ]);
  });

  it("treats zero parsed results as a failure and tries the next source", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://html.duckduckgo.com/")) {
        return new Response(CAPTCHA_HTML, { status: 200 });
      }
      return new Response(DDG_LITE_HTML, { status: 200 });
    });
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("1. Lite & Result");
    expect(calls).toHaveLength(2);
  });

  it("falls through network errors to Bing and returns the unified list format", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url.startsWith("https://www.bing.com/")) {
        return new Response(BING_HTML, { status: 200 });
      }
      throw new TypeError("fetch failed");
    });
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain(
      "1. Bing One\n   https://bing.example.com/one\n   First & bing snippet.",
    );
    expect(res.content).toContain("2. Bing Two");
    expect(res.content).not.toContain("Relative Three");
    expect(calls).toHaveLength(3);
    expect(calls[2]).toBe("https://www.bing.com/search?q=q");
  });

  it("returns one clear error naming every source when all fail", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 403");
    expect(res.content).toContain("duckduckgo-html");
    expect(res.content).toContain("duckduckgo-lite");
    expect(res.content).toContain("bing");
  });

  it("reports no-results across all sources as an error", async () => {
    vi.stubGlobal("fetch", async () => new Response(CAPTCHA_HTML, { status: 200 }));
    const res = await webSearchTool.execute({ query: "q" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("no results");
    expect(res.content).toContain("duckduckgo-html");
  });
});
