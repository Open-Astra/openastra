import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── YouTube Search Skill ──────────────────────────────────────────
// Searches YouTube using the Data API v3 (if YOUTUBE_API_KEY is set)
// or falls back to scraping the YouTube RSS feed.

const YOUTUBE_API_URL = "https://www.googleapis.com/youtube/v3/search";

const YoutubeSearchParams = z.object({
  query: z.string().describe("Search query string"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of results to return (default 5)"),
});

interface YouTubeApiItem {
  id: { videoId?: string };
  snippet: {
    title: string;
    channelTitle: string;
    description: string;
    publishedAt: string;
  };
}

interface YouTubeApiResponse {
  items?: YouTubeApiItem[];
}

function parseRssItems(xml: string, max: number) {
  const entries: Array<{
    title: string;
    videoId: string;
    channelTitle: string;
    description: string;
    publishedAt: string;
  }> = [];

  const entryBlocks = xml.split("<entry>").slice(1);
  for (const block of entryBlocks.slice(0, max)) {
    const title = block.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() ?? "";
    const videoId =
      block.match(/<yt:videoId>([\s\S]*?)<\/yt:videoId>/)?.[1]?.trim() ?? "";
    const channelTitle =
      block.match(/<name>([\s\S]*?)<\/name>/)?.[1]?.trim() ?? "";
    const description =
      block
        .match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]
        ?.trim() ?? "";
    const publishedAt =
      block.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ?? "";

    entries.push({ title, videoId, channelTitle, description, publishedAt });
  }

  return entries;
}

const youtubeSearchSkill: SkillDefinition = {
  name: "youtube_search",
  version: "1.0.0",

  manifest: {
    id: "youtube_search",
    name: "YouTube Search",
    description:
      "Search YouTube for videos. Uses the YouTube Data API v3 when an API key is available, otherwise falls back to RSS feed parsing.",
    category: "search",
    tools: ["youtube_search"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: false,
        description: "YouTube Data API v3 key",
        envVar: "YOUTUBE_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "youtube_search",
      description:
        "Search YouTube for videos. Returns title, videoId, channelTitle, description, and publishedAt.",
      parameters: YoutubeSearchParams,

      async execute(params) {
        const apiKey = process.env.YOUTUBE_API_KEY;

        if (apiKey) {
          // Use YouTube Data API v3
          const url = new URL(YOUTUBE_API_URL);
          url.searchParams.set("part", "snippet");
          url.searchParams.set("type", "video");
          url.searchParams.set("q", params.query);
          url.searchParams.set("maxResults", String(params.maxResults));
          url.searchParams.set("key", apiKey);

          const response = await safeFetch(url.toString(), {
            headers: { Accept: "application/json" },
            ssrfProtection: false,
          });

          if (!response.ok) {
            return {
              error: `YouTube API returned ${response.status}: ${response.statusText}`,
            };
          }

          const body = (await response.json()) as YouTubeApiResponse;
          const items = body.items ?? [];

          return {
            query: params.query,
            source: "youtube_api",
            resultCount: items.length,
            results: items.map((item) => ({
              title: item.snippet.title,
              videoId: item.id.videoId ?? "",
              channelTitle: item.snippet.channelTitle,
              description: item.snippet.description,
              publishedAt: item.snippet.publishedAt,
              url: `https://www.youtube.com/watch?v=${item.id.videoId ?? ""}`,
            })),
          };
        }

        // Fallback: YouTube RSS search feed
        const rssUrl = `https://www.youtube.com/feeds/videos.xml?search_query=${encodeURIComponent(params.query)}`;
        const response = await safeFetch(rssUrl, {
          headers: { Accept: "application/xml" },
          ssrfProtection: false,
        });

        if (!response.ok) {
          return {
            error: `YouTube RSS feed returned ${response.status}: ${response.statusText}`,
          };
        }

        const xml = await response.text();
        const entries = parseRssItems(xml, params.maxResults);

        return {
          query: params.query,
          source: "rss_feed",
          resultCount: entries.length,
          results: entries.map((e) => ({
            ...e,
            url: `https://www.youtube.com/watch?v=${e.videoId}`,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "youtube_search",
      instructions:
        "You can search YouTube for videos using the `youtube_search` tool. Provide a query and optionally the number of results to return.",
    };
  },
};

export default youtubeSearchSkill;
