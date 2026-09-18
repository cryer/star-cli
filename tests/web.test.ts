import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webFetchTool } from "../src/tools/web/fetch";

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
  it("converts HTML to clean text without tags or scripts", async () => {
    const res = await webFetchTool.execute({ url: `${base}/html` }, { cwd: process.cwd() });
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
    const res = await webFetchTool.execute({ url: `${base}/text` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toBe("plain text body\nsecond line");
  });

  it("truncates to maxChars and adds a note", async () => {
    const res = await webFetchTool.execute(
      { url: `${base}/big`, maxChars: 100 },
      { cwd: process.cwd() },
    );
    expect(res.isError).toBeUndefined();
    expect(res.content).toMatch(/^x{100}\n\[truncated, showing first 100 of \d+ chars\]$/);
  });

  it("returns isError for non-2xx responses", async () => {
    const res = await webFetchTool.execute({ url: `${base}/missing` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("HTTP 404");
  });

  it("returns isError for non-http URLs", async () => {
    const res = await webFetchTool.execute(
      { url: "ftp://example.com/file" },
      { cwd: process.cwd() },
    );
    expect(res.isError).toBe(true);
    expect(res.content).toContain("only http(s)");
    const file = await webFetchTool.execute({ url: "file:///etc/passwd" }, { cwd: process.cwd() });
    expect(file.isError).toBe(true);
  });

  it("returns isError for binary content types", async () => {
    const res = await webFetchTool.execute({ url: `${base}/binary` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("application/octet-stream");
  });
});
