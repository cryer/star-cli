import { z } from "zod";
import type { Tool } from "../types";

const DEFAULT_MAX_CHARS = 20000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30000;

const schema = z.object({
  url: z.string().describe("The http(s) URL to fetch"),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum characters of text to return (default 20000)"),
});

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&(quot|lt|gt|nbsp);/g, (m) => {
      switch (m) {
        case "&quot;":
          return '"';
        case "&lt;":
          return "<";
        case "&gt;":
          return ">";
        case "&nbsp;":
          return " ";
        default:
          return m;
      }
    })
    .replace(/&amp;/g, "&");
}

function htmlToText(html: string): string {
  const noBlocks = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const withBreaks = noBlocks.replace(
    /<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|header|footer|blockquote|pre)>/gi,
    "\n",
  );
  const stripped = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "));
  return stripped
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function readBody(res: Response, maxChars: number): Promise<string> {
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= MAX_BYTES || text.length >= maxChars * 2) {
        break;
      }
    }
    text += decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) {
    return s;
  }
  return `${s.slice(0, maxChars)}\n[truncated, showing first ${maxChars} of ${s.length} chars]`;
}

export const webFetchTool: Tool<typeof schema> = {
  name: "web_fetch",
  description:
    "Fetch a URL over http(s) and return its contents as readable text. HTML pages are converted to plain text (tags, scripts and styles removed). Output is truncated to maxChars (default 20000).",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      return { content: `ERROR: invalid URL: ${args.url}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return {
        content: `ERROR: only http(s) URLs are supported, got: ${url.protocol}`,
        isError: true,
      };
    }
    const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
    const signal = ctx.abortSignal
      ? AbortSignal.any([timeoutSignal, ctx.abortSignal])
      : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(url, { signal, redirect: "follow" });
    } catch (err) {
      if (ctx.abortSignal?.aborted) {
        return { content: "ERROR: request aborted", isError: true };
      }
      if (timeoutSignal.aborted) {
        return { content: `ERROR: request timed out after ${TIMEOUT_MS / 1000}s`, isError: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: failed to fetch ${args.url}: ${message}`, isError: true };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return {
        content: `ERROR: HTTP ${res.status} ${res.statusText} for ${args.url}`,
        isError: true,
      };
    }
    const [rawType = ""] = (res.headers.get("content-type") ?? "text/plain").split(";");
    const contentType = rawType.trim().toLowerCase();
    const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
    const isText =
      contentType.startsWith("text/") ||
      contentType === "application/json" ||
      contentType === "application/xml" ||
      contentType.endsWith("+json") ||
      contentType.endsWith("+xml");
    if (!isHtml && !isText) {
      await res.body?.cancel().catch(() => {});
      return {
        content: `ERROR: unsupported content type: ${contentType} (${args.url})`,
        isError: true,
      };
    }
    let body: string;
    try {
      body = await readBody(res, maxChars);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: failed to read response body: ${message}`, isError: true };
    }
    const text = isHtml ? htmlToText(body) : body;
    return { content: truncate(text, maxChars) };
  },
};
