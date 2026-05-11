import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── News Aggregator Skill ────────────────────────────────────────
// Aggregates news from Google News RSS or NewsData.io API.
// NEWS_API_KEY is optional — enhances results when available.

const GOOGLE_NEWS_RSS = "https://news.google.com/rss/search";
const NEWSDATA_API_URL = "https://newsdata.io/api/1/news";

const NewsAggregatorParams = z.object({
  query: z.string().describe("News search query"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of results (default 10)"),
  category: z
    .enum(["business", "technology", "sports", "entertainment", "health", "science"])
    .optional()
    .describe("Optional news category filter"),
});

interface NewsItem {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  description: string;
}

function parseGoogleNewsRss(xml: string, maxResults: number): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRegex.exec(xml)) !== null && items.length < maxResults) {
    const block = match[1];
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const link = block.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? "";
    const pubDate = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? "";
    const source = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1]?.trim() ?? "Unknown";
    const description =
      block
        .match(/<description>([\s\S]*?)<\/description>/)?.[1]
        ?.replace(/<[^>]+>/g, "")
        .trim() ?? "";

    if (title && link) {
      items.push({
        title: decodeXmlEntities(title),
        source: decodeXmlEntities(source),
        url: link,
        publishedAt: pubDate,
        description: decodeXmlEntities(description).slice(0, 300),
      });
    }
  }

  return items;
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

const newsAggregatorSkill: SkillDefinition = {
  name: "news_aggregator",
  version: "1.0.0",

  manifest: {
    id: "news_aggregator",
    name: "News Aggregator",
    description:
      "Aggregates news articles from multiple sources. Uses NewsData.io API when available, falls back to Google News RSS.",
    category: "search",
    tools: ["news_aggregator"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: false,
        description: "NewsData.io API key (optional, enhances results)",
        envVar: "NEWS_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "news_aggregator",
      description:
        "Search and aggregate news articles. Supports category filtering. Uses NewsData.io API if NEWS_API_KEY is set, otherwise falls back to Google News RSS.",
      parameters: NewsAggregatorParams,

      async execute(params) {
        const newsApiKey = process.env.NEWS_API_KEY;

        // Try NewsData.io first if API key is available
        if (newsApiKey) {
          try {
            const url = new URL(NEWSDATA_API_URL);
            url.searchParams.set("apikey", newsApiKey);
            url.searchParams.set("q", params.query);
            url.searchParams.set("language", "en");
            if (params.category) {
              url.searchParams.set("category", params.category);
            }

            const response = await safeFetch(url.toString(), {
              headers: { Accept: "application/json" },
              ssrfProtection: false,
            });

            if (response.ok) {
              const body = (await response.json()) as {
                results?: Array<{
                  title: string;
                  source_id: string;
                  link: string;
                  pubDate: string;
                  description: string;
                }>;
              };

              const results = (body.results ?? []).slice(0, params.maxResults);

              return {
                query: params.query,
                source: "newsdata.io",
                category: params.category ?? "all",
                resultCount: results.length,
                articles: results.map((r) => ({
                  title: r.title ?? "",
                  source: r.source_id ?? "Unknown",
                  url: r.link ?? "",
                  publishedAt: r.pubDate ?? "",
                  description: (r.description ?? "").slice(0, 300),
                })),
              };
            }
          } catch {
            // Fall through to Google News RSS
          }
        }

        // Fallback: Google News RSS
        try {
          const url = new URL(GOOGLE_NEWS_RSS);
          url.searchParams.set("q", params.query);
          url.searchParams.set("hl", "en-US");
          url.searchParams.set("gl", "US");
          url.searchParams.set("ceid", "US:en");

          const response = await safeFetch(url.toString(), {
            ssrfProtection: false,
          });

          if (!response.ok) {
            return {
              error: `Google News RSS returned ${response.status}: ${response.statusText}`,
            };
          }

          const xml = await response.text();
          const articles = parseGoogleNewsRss(xml, params.maxResults);

          return {
            query: params.query,
            source: "google_news_rss",
            category: params.category ?? "all",
            resultCount: articles.length,
            articles,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `News aggregation failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "news_aggregator",
      instructions:
        "You can search for news using the `news_aggregator` tool. Provide a query and optionally filter by category (business, technology, sports, entertainment, health, science).",
    };
  },
};

export default newsAggregatorSkill;
