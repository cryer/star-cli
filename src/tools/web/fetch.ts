import dns from "node:dns";
import { z } from "zod";
import type { Tool } from "../types";

const DEFAULT_MAX_CHARS = 20000;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

const schema = z.object({
  url: z.string().describe("The http(s) URL to fetch"),
  maxChars: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum characters of text to return (default 20000)"),
});

// Resolves a hostname to its IP addresses; injectable so tests (and embedders)
// never touch real DNS. Defaults to the system resolver.
export type WebFetchResolver = (hostname: string) => Promise<string[]>;

export interface WebFetchToolOptions {
  resolver?: WebFetchResolver;
  fetchImpl?: typeof fetch;
  // Overrides the config-wired default (setWebFetchAllowPrivateHosts).
  allowPrivateHosts?: boolean;
}

const defaultResolver: WebFetchResolver = async (hostname) => {
  const results = await dns.promises.lookup(hostname, { all: true });
  return results.map((result) => result.address);
};

// Wired from loadConfig (webFetchAllowPrivateHosts, global config only — the
// project-config sandbox cannot set it). When false, every fetched URL's host
// is resolved and private/reserved addresses are refused, per redirect hop.
let configuredAllowPrivateHosts = false;

export function setWebFetchAllowPrivateHosts(allow: boolean): void {
  configuredAllowPrivateHosts = allow;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isPrivateAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip.includes(".")) return isPrivateIpv4(ip);
  if (ip === "::1" || ip === "::") return true;
  // fc00::/7 (ULA) and fe80::/10 (link-local).
  if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(ip)) return true;
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return (
    h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")
  );
}

// Returns a refusal message when the URL's host is local/private/reserved,
// null when it is safe to connect. DNS answers are checked too, so a public
// hostname that resolves to 169.254.169.254 is refused like a literal IP.
async function privateHostRefusal(url: URL, resolve: WebFetchResolver): Promise<string | null> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isLocalHostname(hostname)) {
    return `"${hostname}" is a local/internal hostname`;
  }
  let addresses: string[];
  try {
    addresses = await resolve(hostname);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `could not resolve "${hostname}" (${message})`;
  }
  const blocked = addresses.find(isPrivateAddress);
  if (blocked !== undefined) {
    return `"${hostname}" resolves to a private/reserved address (${blocked})`;
  }
  if (addresses.length === 0) {
    return `could not resolve "${hostname}"`;
  }
  return null;
}

// String.fromCodePoint throws a RangeError on code points past U+10FFFF;
// keep the original entity text for those instead of dying mid-page.
function safeCodePoint(n: number, raw: string): string {
  if (!Number.isInteger(n) || n < 0 || n > 0x10ffff) {
    return raw;
  }
  return String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (m, n) => safeCodePoint(Number(n), m))
    .replace(/&#x([0-9a-fA-F]+);/gi, (m, n) => safeCodePoint(Number.parseInt(n, 16), m))
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

export function createWebFetchTool(options: WebFetchToolOptions = {}): Tool<typeof schema> {
  const resolve = options.resolver ?? defaultResolver;
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const allowPrivate = () => options.allowPrivateHosts ?? configuredAllowPrivateHosts;
  return {
    name: "web_fetch",
    description:
      "Fetch a URL over http(s) and return its contents as readable text. HTML pages are converted to plain text (tags, scripts and styles removed). Output is truncated to maxChars (default 20000). Private/reserved addresses (loopback, RFC1918, link-local incl. 169.254.169.254, localhost/.local/.internal names) are refused by default, on redirect hops too — the global config key webFetchAllowPrivateHosts lifts that for trusted intranet use.",
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
      if (!allowPrivate()) {
        const refusal = await privateHostRefusal(url, resolve);
        if (refusal !== null) {
          return { content: `ERROR: refused to fetch ${args.url}: ${refusal}`, isError: true };
        }
      }
      const maxChars = args.maxChars ?? DEFAULT_MAX_CHARS;
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
      const signal = ctx.abortSignal
        ? AbortSignal.any([timeoutSignal, ctx.abortSignal])
        : timeoutSignal;
      // Redirects are followed manually so every hop's host is re-validated;
      // a public page must not bounce the tool into a metadata endpoint.
      let res: Response | undefined;
      let current = url;
      for (let hops = 0; ; hops += 1) {
        try {
          res = await fetchImpl(current, { signal, redirect: "manual" });
        } catch (err) {
          if (ctx.abortSignal?.aborted) {
            return { content: "ERROR: request aborted", isError: true };
          }
          if (timeoutSignal.aborted) {
            return {
              content: `ERROR: request timed out after ${TIMEOUT_MS / 1000}s`,
              isError: true,
            };
          }
          const message = err instanceof Error ? err.message : String(err);
          return { content: `ERROR: failed to fetch ${current.href}: ${message}`, isError: true };
        }
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location && hops < MAX_REDIRECTS) {
          await res.body?.cancel().catch(() => {});
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            return { content: `ERROR: invalid redirect Location: ${location}`, isError: true };
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            return {
              content: `ERROR: redirect to non-http(s) URL refused: ${next.protocol}`,
              isError: true,
            };
          }
          if (!allowPrivate()) {
            const refusal = await privateHostRefusal(next, resolve);
            if (refusal !== null) {
              return {
                content: `ERROR: refused redirect to ${next.href}: ${refusal}`,
                isError: true,
              };
            }
          }
          current = next;
          continue;
        }
        break;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return {
          content: `ERROR: HTTP ${res.status} ${res.statusText} for ${current.href}`,
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
          content: `ERROR: unsupported content type: ${contentType} (${current.href})`,
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
}

export const webFetchTool: Tool<typeof schema> = createWebFetchTool();
