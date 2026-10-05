import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWebFetchTool } from "../src/tools/web/fetch";

// Same loopback-server pattern as web.test.ts (behavior through the real
// tool with the SSRF escape hatch open; the guard itself lives in
// web.test.ts and is untouched here).
const tool = createWebFetchTool({ allowPrivateHosts: true });

let server: http.Server;
let base: string;

// "中文" encoded as GBK (中 = D6 D0, 文 = CE C4).
const GBK_TEXT = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
const GBK_PAGE = Buffer.concat([
  Buffer.from("<html><body><p>"),
  GBK_TEXT,
  Buffer.from(" page</p></body></html>"),
]);

const LINKS_PAGE = `<!DOCTYPE html>
<html><body>
<p><a href="https://example.com/abs">Absolute link</a></p>
<p><a href="next">Relative link</a></p>
<p><a href="../up">Parent link</a></p>
<p><a href="https://self.example.com/">https://self.example.com/</a></p>
<p><a href="javascript:void(0)">JS link</a></p>
<p><a href="#section">Fragment link</a></p>
<p><a href="https://icon.example.com/img"><img src="icon.png" alt=""></a></p>
</body></html>`;

const manyLinksPage = (n: number) =>
  `<html><body><p>${Array.from(
    { length: n },
    (_, i) => `<a href="https://links.example.com/${i}">Link ${i}</a> `,
  ).join("")}</p></body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    switch (req.url) {
      case "/gbk":
        res.writeHead(200, { "content-type": "text/html; charset=gbk" });
        res.end(GBK_PAGE);
        break;
      case "/no-charset":
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<p>中文 utf8</p>");
        break;
      case "/unknown-charset":
        res.writeHead(200, { "content-type": "text/html; charset=x-no-such-charset" });
        res.end("<p>héllo 中文</p>");
        break;
      case "/dir/page":
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LINKS_PAGE);
        break;
      case "/link-cap":
        res.writeHead(200, { "content-type": "text/html" });
        res.end(manyLinksPage(60));
        break;
      case "/pdf-type":
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(Buffer.from("%PDF-1.5 fake"));
        break;
      case "/pdf-magic":
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(Buffer.from("%PDF-1.7 mislabeled"));
        break;
      case "/pdf-text":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(Buffer.from("%PDF-1.4 served as text"));
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

describe("web_fetch charset handling", () => {
  it("decodes a GBK page declared in the content-type charset", async () => {
    const res = await tool.execute({ url: `${base}/gbk` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("中文 page");
  });

  it("falls back to utf-8 when no charset is declared", async () => {
    const res = await tool.execute({ url: `${base}/no-charset` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("中文 utf8");
  });

  it("falls back to utf-8 for unknown charset labels without failing", async () => {
    const res = await tool.execute({ url: `${base}/unknown-charset` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("héllo 中文");
  });
});

describe("web_fetch link preservation", () => {
  it("keeps links inline as `anchor (url)` and absolutizes relative hrefs", async () => {
    const res = await tool.execute({ url: `${base}/dir/page` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    expect(res.content).toContain("Absolute link (https://example.com/abs)");
    expect(res.content).toContain(`Relative link (${base}/dir/next)`);
    expect(res.content).toContain(`Parent link (${base}/up)`);
  });

  it("does not annotate self-linked URLs, javascript: links or fragments", async () => {
    const res = await tool.execute({ url: `${base}/dir/page` }, { cwd: process.cwd() });
    expect(res.content).toContain("https://self.example.com/");
    expect(res.content).not.toContain("(https://self.example.com/)");
    expect(res.content).toContain("JS link");
    expect(res.content).not.toContain("javascript:");
    expect(res.content).toContain("Fragment link");
    expect(res.content).not.toContain("#section");
  });

  it("renders text-less anchors as their bare URL", async () => {
    const res = await tool.execute({ url: `${base}/dir/page` }, { cwd: process.cwd() });
    expect(res.content).toContain("https://icon.example.com/img");
  });

  it("caps the number of annotated links", async () => {
    const res = await tool.execute({ url: `${base}/link-cap` }, { cwd: process.cwd() });
    expect(res.isError).toBeUndefined();
    const annotated = res.content.match(/\(https:\/\/links\.example\.com\//g) ?? [];
    expect(annotated).toHaveLength(50);
    expect(res.content).toContain("Link 59");
  });
});

describe("web_fetch PDF handling", () => {
  it("returns a clear tool error for application/pdf responses", async () => {
    const res = await tool.execute({ url: `${base}/pdf-type` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("PDF is not supported by web_fetch");
    expect(res.content).toContain("Do not retry");
  });

  it("detects PDFs by magic bytes when the content type is wrong", async () => {
    const res = await tool.execute({ url: `${base}/pdf-magic` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("PDF is not supported by web_fetch");
    expect(res.content).not.toContain("unsupported content type");
  });

  it("detects PDFs mislabeled as text", async () => {
    const res = await tool.execute({ url: `${base}/pdf-text` }, { cwd: process.cwd() });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("PDF is not supported by web_fetch");
  });
});
