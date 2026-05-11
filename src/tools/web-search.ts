import { z } from "zod";
import { registerTool } from "./registry.js";

// ── web_search ────────────────────────────────────────────────────────
// Generic web search using Brave Search API (preferred) or DuckDuckGo
// HTML fallback when no API key is configured.

const WebSearchParams = z.object({
  query: z.string().min(1).describe("Search query string"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return (default 5, max 20)"),
  site: z
    .string()
    .optional()
    .describe("Optional site filter (e.g. 'github.com' to search only that domain)"),
});

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Simple delay helper
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchBrave(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const MAX_RETRIES = 3;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential backoff: 1s, 2s, 4s + jitter
      await sleep(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
    }

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (res.status === 429) {
      lastError = `Brave Search API error: 429 Too Many Requests (attempt ${attempt + 1}/${MAX_RETRIES + 1})`;
      continue;
    }

    if (!res.ok) {
      throw new Error(`Brave Search API error: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as {
      web?: {
        results?: Array<{
          title?: string;
          url?: string;
          description?: string;
        }>;
      };
    };

    const results: SearchResult[] = [];
    for (const r of data.web?.results ?? []) {
      if (r.url) {
        results.push({
          title: r.title ?? "",
          url: r.url,
          snippet: r.description ?? "",
        });
      }
    }

    return results.slice(0, maxResults);
  }

  // All retries exhausted
  throw new Error(lastError);
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: {
      "User-Agent": "Astra-Agent/1.0",
    },
  });

  if (!res.ok) {
    throw new Error(`DuckDuckGo search error: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // Parse results from DuckDuckGo HTML response
  const results: SearchResult[] = [];
  const resultPattern = /<a[^>]+class="result__a"[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>(.*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1] ?? "";
    const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
    const snippet = (match[3] ?? "").replace(/<[^>]+>/g, "").trim();

    // DuckDuckGo wraps URLs in a redirect — try to extract the actual URL
    let finalUrl = rawUrl;
    try {
      const parsed = new URL(rawUrl, "https://duckduckgo.com");
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) finalUrl = decodeURIComponent(uddg);
    } catch {
      // Use raw URL if parsing fails
    }

    if (title && finalUrl) {
      results.push({ title, url: finalUrl, snippet });
    }
  }

  // Fallback: simpler pattern if the above yields nothing
  if (results.length === 0) {
    const simplePattern = /<a[^>]+class="result__url"[^>]+href="([^"]*)"[^>]*>(.*?)<\/a>/gi;
    while ((match = simplePattern.exec(html)) !== null && results.length < maxResults) {
      const rawUrl = match[1] ?? "";
      const title = (match[2] ?? "").replace(/<[^>]+>/g, "").trim();
      if (title && rawUrl) {
        results.push({ title, url: rawUrl, snippet: "" });
      }
    }
  }

  return results;
}

registerTool({
  name: "web_search",
  description:
    "Search the web and return results with titles, URLs, and snippets. Uses Brave Search API when BRAVE_API_KEY is configured, otherwise falls back to DuckDuckGo. Supports site-specific search.",
  parameters: WebSearchParams,
  async execute(params) {
    try {
      let query = params.query;
      if (params.site) {
        query = `site:${params.site} ${query}`;
      }

      const braveApiKey = process.env.BRAVE_API_KEY;

      let results: SearchResult[];
      let provider: string;

      if (braveApiKey) {
        results = await searchBrave(query, params.maxResults, braveApiKey);
        provider = "brave";
      } else {
        results = await searchDuckDuckGo(query, params.maxResults);
        provider = "duckduckgo";
      }

      return {
        query: params.query,
        site: params.site ?? null,
        provider,
        resultCount: results.length,
        results,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
  },
});
