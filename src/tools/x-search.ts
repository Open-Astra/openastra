import { z } from "zod";
import { registerTool } from "./registry.js";

// ── x_search ────────────────────────────────────────────────────────
// Searches X/Twitter via API v2 for real-time injury reports, lineup
// confirmations, and prop-relevant news.

const XSearchParams = z.object({
  query: z.string().describe("Search query for X/Twitter"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return"),
});

interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
  };
}

interface XSearchResponse {
  data?: XTweet[];
  meta?: {
    newest_id: string;
    oldest_id: string;
    result_count: number;
  };
}

registerTool({
  name: "x_search",
  retryable: true,
  description:
    "Search X/Twitter for real-time sports news, injury reports, lineup confirmations, and betting-relevant information.",
  parameters: XSearchParams,

  async execute(params) {
    const bearerToken = process.env.X_BEARER_TOKEN || process.env.GROK_API_KEY;
    if (!bearerToken) {
      return {
        query: params.query,
        results: [],
        message: "X search unavailable — no bearer token configured.",
      };
    }

    try {
      const url = new URL("https://api.twitter.com/2/tweets/search/recent");
      url.searchParams.set("query", params.query);
      url.searchParams.set("max_results", String(Math.max(params.maxResults, 10))); // API minimum is 10
      url.searchParams.set("tweet.fields", "created_at,author_id,public_metrics");
      url.searchParams.set("sort_order", "relevancy");

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${bearerToken}` },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // 403 = token doesn't have search access, degrade gracefully
        if (res.status === 403 || res.status === 401) {
          return {
            query: params.query,
            results: [],
            message: `X search returned ${res.status} — bearer token may not have search access. Check X API tier.`,
          };
        }
        throw new Error(`X API ${res.status}: ${body || res.statusText}`);
      }

      const data = (await res.json()) as XSearchResponse;
      const tweets = data.data ?? [];

      // Trim to requested max (API minimum is 10, user may want fewer)
      const trimmed = tweets.slice(0, params.maxResults);

      return {
        query: params.query,
        results: trimmed.map((t) => ({
          id: t.id,
          text: t.text,
          createdAt: t.created_at,
          likes: t.public_metrics?.like_count ?? 0,
          retweets: t.public_metrics?.retweet_count ?? 0,
        })),
        message: `Found ${trimmed.length} result(s) for "${params.query}".`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        query: params.query,
        results: [],
        message: `X search error: ${message}`,
      };
    }
  },
});
