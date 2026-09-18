import { z } from "zod";
import type { Tool } from "../types";
import { decodeEntities } from "./fetch";

const TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
const SEARCH_URL = "https://html.duckduckgo.com/html/?q=";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const schema = z.object({
  query: z.string().min(1).describe("The search query"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_LIMIT)
    .optional()
    .describe(
      `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_LIMIT})`,
    ),
});

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(href: string): string {
  const decoded = decodeEntities(href);
  const uddg = decoded.match(/[?&]uddg=([^&]+)/);
  if (uddg?.[1]) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return decoded;
    }
  }
  if (decoded.startsWith("//")) {
    return `https:${decoded}`;
  }
  return decoded;
}

export function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a\b[^>]*\bclass\s*=\s*"[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  for (const [i, anchor] of anchors.entries()) {
    const full = anchor[0];
    const hrefMatch = full.match(/href\s*=\s*"([^"]*)"/i);
    if (!hrefMatch?.[1]) {
      continue;
    }
    const url = normalizeUrl(hrefMatch[1]);
    const title = stripTags(full.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>\s*$/i, ""));
    const blockStart = (anchor.index ?? 0) + full.length;
    const blockEnd = i + 1 < anchors.length ? (anchors[i + 1]?.index ?? html.length) : html.length;
    const block = html.slice(blockStart, blockEnd);
    const snippetMatch = block.match(
      /<(?:a|div)\b[^>]*\bclass\s*=\s*"[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i,
    );
    const snippet = snippetMatch?.[1] ? stripTags(snippetMatch[1]) : "";
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

export const webSearchTool: Tool<typeof schema> = {
  name: "web_search",
  description:
    "Search the web using DuckDuckGo and return a numbered list of results with title, URL and snippet. No API key required. Use web_fetch to read a result's full page.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const maxResults = Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
    const url = `${SEARCH_URL}${encodeURIComponent(args.query)}`;
    const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
    const signal = ctx.abortSignal
      ? AbortSignal.any([timeoutSignal, ctx.abortSignal])
      : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "text/html" },
      });
    } catch (err) {
      if (ctx.abortSignal?.aborted) {
        return { content: "ERROR: request aborted", isError: true };
      }
      const name = err instanceof Error ? err.name : "";
      if (timeoutSignal.aborted || name === "TimeoutError") {
        return { content: `ERROR: search timed out after ${TIMEOUT_MS / 1000}s`, isError: true };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: search request failed: ${message}`, isError: true };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return {
        content: `ERROR: HTTP ${res.status} ${res.statusText} from DuckDuckGo`,
        isError: true,
      };
    }
    let html: string;
    try {
      html = await res.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `ERROR: failed to read search response: ${message}`, isError: true };
    }
    const results = parseResults(html).slice(0, maxResults);
    if (results.length === 0) {
      return {
        content: `ERROR: no results found for "${args.query}" (the response may have been blocked or the page layout changed)`,
        isError: true,
      };
    }
    const lines = results.map(
      (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
    );
    return { content: lines.join("\n") };
  },
};
