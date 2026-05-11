import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Wikipedia Skill ───────────────────────────────────────────────
// Search Wikipedia or get article summaries. Free, no API key needed.

const WIKI_REST_API = "https://en.wikipedia.org/api/rest_v1";
const WIKI_ACTION_API = "https://en.wikipedia.org/w/api.php";

const WikipediaParams = z.object({
  operation: z
    .enum(["search", "get_article"])
    .describe("Operation: search for articles or get a specific article summary"),
  query: z
    .string()
    .optional()
    .describe("Search query. Required for search."),
  title: z
    .string()
    .optional()
    .describe("Article title. Required for get_article."),
});

interface WikiSearchResult {
  title: string;
  snippet: string;
  pageid: number;
  wordcount: number;
}

interface WikiSearchResponse {
  query?: {
    search?: WikiSearchResult[];
  };
}

interface WikiSummaryResponse {
  title: string;
  extract: string;
  description?: string;
  content_urls?: {
    desktop?: { page?: string };
  };
  thumbnail?: {
    source: string;
    width: number;
    height: number;
  };
}

const wikipediaSkill: SkillDefinition = {
  name: "wikipedia",
  version: "1.0.0",

  manifest: {
    id: "wikipedia",
    name: "Wikipedia",
    description:
      "Search Wikipedia or get article summaries. Free, no API key needed.",
    category: "search",
    tools: ["wikipedia"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "wikipedia",
      description:
        "Search Wikipedia for articles or get the summary of a specific article by title.",
      parameters: WikipediaParams,

      async execute(params) {
        const { operation } = params;

        switch (operation) {
          case "search": {
            if (!params.query)
              return { error: "query is required for search." };

            const url = new URL(WIKI_ACTION_API);
            url.searchParams.set("action", "query");
            url.searchParams.set("list", "search");
            url.searchParams.set("srsearch", params.query);
            url.searchParams.set("srlimit", "10");
            url.searchParams.set("format", "json");
            url.searchParams.set("origin", "*");

            const response = await safeFetch(url.toString(), {
              headers: { Accept: "application/json" },
              ssrfProtection: false,
            });

            if (!response.ok) {
              return {
                error: `Wikipedia search failed: ${response.status} ${response.statusText}`,
              };
            }

            const data = (await response.json()) as WikiSearchResponse;
            const results = data.query?.search ?? [];

            return {
              query: params.query,
              resultCount: results.length,
              results: results.map((r) => ({
                title: r.title,
                snippet: r.snippet.replace(/<[^>]*>/g, ""),
                wordCount: r.wordcount,
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
              })),
            };
          }

          case "get_article": {
            if (!params.title)
              return { error: "title is required for get_article." };

            const encodedTitle = encodeURIComponent(
              params.title.replace(/ /g, "_"),
            );
            const url = `${WIKI_REST_API}/page/summary/${encodedTitle}`;

            const response = await safeFetch(url, {
              headers: { Accept: "application/json" },
              ssrfProtection: false,
            });

            if (!response.ok) {
              if (response.status === 404) {
                return {
                  error: `Article not found: "${params.title}". Try searching first.`,
                };
              }
              return {
                error: `Wikipedia API failed: ${response.status} ${response.statusText}`,
              };
            }

            const data = (await response.json()) as WikiSummaryResponse;

            return {
              title: data.title,
              description: data.description ?? "",
              summary: data.extract,
              url:
                data.content_urls?.desktop?.page ??
                `https://en.wikipedia.org/wiki/${encodedTitle}`,
              thumbnail: data.thumbnail
                ? {
                    url: data.thumbnail.source,
                    width: data.thumbnail.width,
                    height: data.thumbnail.height,
                  }
                : null,
            };
          }

          default:
            return { error: `Unknown operation: ${operation}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "wikipedia",
      instructions:
        "You can look up information on Wikipedia using the `wikipedia` tool. Use the search operation to find articles by query, or get_article to retrieve the summary of a specific article by title.",
    };
  },
};

export default wikipediaSkill;
