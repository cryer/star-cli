import { z } from "zod";
import { debugStreamLog } from "../../llm/debug";
import type { Tool } from "../types";
import { decodeEntities } from "./fetch";

const TIMEOUT_MS = 15000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_LIMIT = 10;
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

// A search backend: builds the request URL for a query and parses its HTML
// into the unified {title, url, snippet} shape. Sources are tried in order;
// a network error, non-2xx status or zero parsed results falls through to
// the next one.
interface SearchSource {
  name: string;
  buildUrl: (query: string) => string;
  parse: (html: string) => SearchResult[];
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

function hrefOf(tag: string): string | undefined {
  const match = tag.match(/href\s*=\s*"([^"]*)"/i) ?? tag.match(/href\s*=\s*'([^']*)'/i);
  return match?.[1];
}

export function parseResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe = /<a\b[^>]*\bclass\s*=\s*"[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  for (const [i, anchor] of anchors.entries()) {
    const full = anchor[0];
    const href = hrefOf(full);
    if (!href) {
      continue;
    }
    const url = normalizeUrl(href);
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

// lite.duckduckgo.com serves a different (table-based) layout: titles in
// <a class="result-link">, snippets in the following <td class="result-snippet">.
export function parseDdgLiteResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const anchorRe =
    /<a\b[^>]*\bclass\s*=\s*["'][^"']*\bresult-link\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];
  for (const [i, anchor] of anchors.entries()) {
    const full = anchor[0];
    const href = hrefOf(full);
    if (!href) {
      continue;
    }
    const url = normalizeUrl(href);
    const title = stripTags(full.replace(/^<a\b[^>]*>/i, "").replace(/<\/a>\s*$/i, ""));
    const blockStart = (anchor.index ?? 0) + full.length;
    const blockEnd = i + 1 < anchors.length ? (anchors[i + 1]?.index ?? html.length) : html.length;
    const block = html.slice(blockStart, blockEnd);
    const snippetMatch = block.match(
      /<td\b[^>]*\bclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i,
    );
    const snippet = snippetMatch?.[1] ? stripTags(snippetMatch[1]) : "";
    if (title && url) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

// www.bing.com/search needs no key: results are <li class="b_algo"> blocks
// with the title link in <h2><a> and the snippet in the block's first <p>.
export function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockRe = /<li\b[^>]*\bclass\s*=\s*"[^"]*\bb_algo\b[^"]*"[^>]*>/gi;
  const blocks = [...html.matchAll(blockRe)];
  for (const [i, block] of blocks.entries()) {
    const start = block.index ?? 0;
    const end = i + 1 < blocks.length ? (blocks[i + 1]?.index ?? html.length) : html.length;
    const slice = html.slice(start, end);
    const headMatch = slice.match(
      /<h2\b[^>]*>[\s\S]*?<a\b[^>]*?\shref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i,
    );
    if (!headMatch) {
      continue;
    }
    const url = decodeEntities(headMatch[1] ?? "").trim();
    const title = stripTags(headMatch[2] ?? "");
    const snippetMatch = slice.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = snippetMatch?.[1] ? stripTags(snippetMatch[1]) : "";
    if (title && /^https?:\/\//.test(url)) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

const SEARCH_SOURCES: SearchSource[] = [
  {
    name: "duckduckgo-html",
    buildUrl: (query) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    parse: parseResults,
  },
  {
    name: "duckduckgo-lite",
    buildUrl: (query) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
    parse: parseDdgLiteResults,
  },
  {
    name: "bing",
    buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    parse: parseBingResults,
  },
];

export const webSearchTool: Tool<typeof schema> = {
  name: "web_search",
  description:
    "Search the web and return a numbered list of results with title, URL and snippet. Uses DuckDuckGo with automatic fallback to DuckDuckGo Lite and Bing when a source fails or returns nothing. No API key required. Use web_fetch to read a result's full page.",
  permission: "read",
  parameters: schema,
  async execute(args, ctx) {
    const maxResults = Math.min(args.maxResults ?? DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT);
    const failures: string[] = [];
    for (const source of SEARCH_SOURCES) {
      const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
      const signal = ctx.abortSignal
        ? AbortSignal.any([timeoutSignal, ctx.abortSignal])
        : timeoutSignal;
      let res: Response;
      try {
        res = await fetch(source.buildUrl(args.query), {
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
          failures.push(`${source.name}: search timed out after ${TIMEOUT_MS / 1000}s`);
        } else {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${source.name}: search request failed: ${message}`);
        }
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        failures.push(`${source.name}: HTTP ${res.status} ${res.statusText}`);
        continue;
      }
      let html: string;
      try {
        html = await res.text();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${source.name}: failed to read search response: ${message}`);
        continue;
      }
      const results = source.parse(html).slice(0, maxResults);
      if (results.length === 0) {
        failures.push(
          `${source.name}: no results found (the response may have been blocked or the page layout changed)`,
        );
        continue;
      }
      debugStreamLog("web_search", {
        source: source.name,
        query: args.query,
        results: results.length,
        failures,
      });
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`,
      );
      return { content: lines.join("\n") };
    }
    debugStreamLog("web_search_failed", { query: args.query, failures });
    return {
      content: `ERROR: web search failed for "${args.query}" — ${failures.join("; ")}`,
      isError: true,
    };
  },
};
