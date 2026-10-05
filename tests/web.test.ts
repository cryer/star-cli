import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createWebFetchTool,
  decodeEntities,
  setWebFetchAllowPrivateHosts,
} from "../src/tools/web/fetch";

// The behavior tests below run against a real loopback HTTP server, so they
// use an instance with the SSRF guard's escape hatch open. The guard itself
// is tested separately with an injected resolver/fetch (no network).
const tool = createWebFetchTool({ allowPrivateHosts: true });

let server: http.Server;
let base: string;

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head><title>Test Page</title><style>body { color: red; }</style></head>
<body>
<script>alert("hidden");</script>
<noscript>no script fallback</noscript>
<template><span>template content</span></template>
<h1>Hello &amp; Welcome</h1>
<p>First &lt;paragraph&gt; with &#39;quotes&#39; and &quot;double&quot;.</p>
<p>Second&nbsp;paragraph &#65;&#x42;</p>
</body>
</html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/html":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML_PAGE);
        break;
      case "/text":
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("plain text body\nsecond line");
        break;
      case "/big":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("x".repeat(5000));
        break;
      case "/binary":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from([0, 1, 2, 3]));
        break;
      case "/json":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        break;
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("web_fetch", () => {
  it("decodes numeric entities and keeps out-of-range code points literal", () => {
    expect(decodeEntities("&#65; &#x42; &amp; &lt;")).toBe("A B & <");
    expect(decodeEntities("&#x4E2D;&#25991;")).toBe("中文");
    expect(decodeEntities("&#x110000;")).toBe("&#x110000;");
    expect(decodeEntities("&#99999999999;")).toBe("&#99999999999;");
  });

  it("converts HTML to clean text without tags or scripts", async () => {
    const res = await tool.execute({ url: `${base}/html` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("Hello & Welcome");
    expect(res.content).toContain("First <paragraph> with 'quotes' and \"double\".");
    expect(res.content).toContain("Second paragraph AB");
    expect(res.content).not.toMatch(/<\/?(h1|p|script|style|html|body|head)[\s>]/);
    expect(res.content).not.toContain("alert");
    expect(res.content).not.toContain("color: red");
    expect(res.content).not.toContain("no script fallback");
    expect(res.content).not.toContain("template content");
  });

  it("passes plain text through as-is", async () => {
    const res = await tool.execute({ url: `${base}/text` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("plain text body\nsecond line");
  });

  it("truncates to maxChars and adds a note", async () => {
    const res = await tool.execute({ url: `${base}/big`, maxChars: 100 }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/^x{100}\n\[truncated, showing first 100 of \d+ chars\]$/);
  });

  it("returns isError for non-2xx responses", async () => {
    const res = await tool.execute({ url: `${base}/missing` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 404");
  });

  it("returns isError for non-http URLs", async () => {
    const res = await tool.execute({ url: "ftp://example.com/file" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("only http(s)");
    const file = await tool.execute({ url: "file:///etc/passwd" }, { cwd: process.cwd() });
    expect(file.isError).toBe(true);
  });

  it("returns isError for binary content types", async () => {
    const res = await tool.execute({ url: `${base}/binary` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("application/octet-stream");
  });
});

describe("web_fetch SSRF guard", () => {
  afterEach(() => {
    setWebFetchAllowPrivateHosts(false);
  });

  const okResponse = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain" } });

  it("refuses hosts that resolve to private/reserved addresses", async () => {
    let fetches = 0;
    const guarded = createWebFetchTool({
      resolver: async () => ["192.168.1.1"],
      fetchImpl: async () => {
        fetches += 1;
        return okResponse("never");
      },
    });
    const res = await guarded.execute(
      { url: "http://intranet.example.com/" },
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("private/reserved");
    expect(res.content).toContain("192.168.1.1");
    expect(fetches).toBe(0);
  });

  it("refuses the cloud metadata address and loopback/ULA literals", async () => {
    const guarded = createWebFetchTool({
      resolver: async (hostname) => [hostname],
      fetchImpl: async () => okResponse("never"),
    });
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://127.0.0.1:8080/admin",
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://[::1]:8080/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      const res = await guarded.execute({ url }, { cwd: process.cwd() });
      expect(res.isError, url).toBe(true);
      expect(res.content, url).toContain("private/reserved");
    }
  });

  it("refuses localhost and .localhost/.local/.internal names without resolving", async () => {
    let resolved = 0;
    const guarded = createWebFetchTool({
      resolver: async () => {
        resolved += 1;
        return ["93.184.216.34"];
      },
      fetchImpl: async () => okResponse("never"),
    });
    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://printer.local/",
      "http://db.internal/",
    ]) {
      const res = await guarded.execute({ url }, { cwd: process.cwd() });
      expect(res.isError, url).toBe(true);
      expect(res.content, url).toContain("local/internal hostname");
    }
    expect(resolved).toBe(0);
  });

  it("allows hosts that resolve to public addresses", async () => {
    const guarded = createWebFetchTool({
      resolver: async () => ["93.184.216.34"],
      fetchImpl: async () => okResponse("hello public internet"),
    });
    const res = await guarded.execute({ url: "http://example.com/" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("hello public internet");
  });

  it("fails closed when the hostname cannot be resolved", async () => {
    const guarded = createWebFetchTool({
      resolver: async () => {
        throw new Error("ENOTFOUND");
      },
      fetchImpl: async () => okResponse("never"),
    });
    const res = await guarded.execute({ url: "http://nope.example.com/" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("could not resolve");
  });

  it("re-validates every redirect hop and refuses a bounce to the metadata address", async () => {
    let metadataFetches = 0;
    const guarded = createWebFetchTool({
      resolver: async (hostname) => [hostname],
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("169.254.169.254")) {
          metadataFetches += 1;
          return okResponse("metadata");
        }
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    });
    const res = await guarded.execute({ url: "http://example.com/" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("refused redirect");
    expect(res.content).toContain("169.254.169.254");
    expect(metadataFetches).toBe(0);
  });

  it("follows redirects between public hosts, including relative Locations", async () => {
    const seen: string[] = [];
    const guarded = createWebFetchTool({
      resolver: async () => ["93.184.216.34"],
      fetchImpl: async (input) => {
        const url = String(input);
        seen.push(url);
        if (url === "http://example.com/") {
          return new Response(null, { status: 302, headers: { location: "/page2" } });
        }
        return okResponse("redirected page");
      },
    });
    const res = await guarded.execute({ url: "http://example.com/" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("redirected page");
    expect(seen).toEqual(["http://example.com/", "http://example.com/page2"]);
  });

  it("gives up after 5 redirect hops", async () => {
    const guarded = createWebFetchTool({
      resolver: async () => ["93.184.216.34"],
      fetchImpl: async (input) =>
        new Response(null, {
          status: 302,
          headers: { location: `${String(input)}?hop` },
        }),
    });
    const res = await guarded.execute({ url: "http://example.com/" }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 302");
  });

  it("lets private addresses through with allowPrivateHosts (per-option or config-wired)", async () => {
    const resolver = async () => ["192.168.1.1"];
    const fetchImpl = async () => okResponse("intranet page");
    const open = createWebFetchTool({ resolver, fetchImpl, allowPrivateHosts: true });
    const res = await open.execute({ url: "http://intranet/" }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("intranet page");

    const wired = createWebFetchTool({ resolver, fetchImpl });
    setWebFetchAllowPrivateHosts(true);
    const res2 = await wired.execute({ url: "http://intranet/" }, { cwd: process.cwd() });
    expect(res2.isError).toBeUndefined();
    setWebFetchAllowPrivateHosts(false);
    const res3 = await wired.execute({ url: "http://intranet/" }, { cwd: process.cwd() });
    expect(res3.isError).toBe(true);
  });
});
