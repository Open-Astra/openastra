import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Brave Search Skill ────────────────────────────────────────────
// Searches the web using the Brave Search API.
// Requires BRAVE_API_KEY environment variable.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const BraveSearchParams = z.object({
  query: z.string().describe("Search query string"),
  count: z.number().int().min(1).max(20).default(5).describe("Number of results to return (default 5)"),
});

const braveSearchSkill: SkillDefinition = {
  name: "brave_search",
  version: "1.0.0",

  manifest: {
    id: "brave_search",
    name: "Brave Search",
    description: "Search the web using the Brave Search API. Returns titles, URLs, and descriptions for matching web pages.",
    category: "search",
    tools: ["brave_search"],
    configFields: [
      {
        name: "apiKey",
        type: "string",
        required: true,
        description: "Brave Search API key",
        envVar: "BRAVE_API_KEY",
      },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "brave_search",
      description: "Search the web using Brave Search. Returns titles, URLs, and descriptions.",
      parameters: BraveSearchParams,

      async execute(params) {
        const apiKey = process.env.BRAVE_API_KEY;
        if (!apiKey) {
          return { error: "BRAVE_API_KEY environment variable is not set." };
        }

        const url = new URL(BRAVE_SEARCH_URL);
        url.searchParams.set("q", params.query);
        url.searchParams.set("count", String(params.count));

        const response = await safeFetch(url.toString(), {
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "X-Subscription-Token": apiKey,
          },
          ssrfProtection: false,
        });

        if (!response.ok) {
          return { error: `Brave Search API returned ${response.status}: ${response.statusText}` };
        }

        const body = (await response.json()) as {
          web?: { results?: Array<{ title: string; url: string; description: string }> };
        };
        const results = body.web?.results ?? [];

        return {
          query: params.query,
          resultCount: results.length,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            description: r.description,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "brave_search",
      instructions: "You can search the web using the `brave_search` tool. Provide a query and optionally the number of results.",
    };
  },
};

export default braveSearchSkill;
