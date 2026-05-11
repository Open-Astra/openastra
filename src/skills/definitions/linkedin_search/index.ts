import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── LinkedIn Search Skill ────────────────────────────────────────
// Searches LinkedIn profiles, companies, or jobs via Brave Search
// with a site:linkedin.com prefix. Requires BRAVE_API_KEY.

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

const LINKEDIN_PATHS: Record<string, string> = {
  people: "linkedin.com/in",
  companies: "linkedin.com/company",
  jobs: "linkedin.com/jobs",
};

const LinkedInSearchParams = z.object({
  query: z.string().describe("Search query (e.g. person name, company, job title)"),
  type: z
    .enum(["people", "companies", "jobs"])
    .default("people")
    .describe("Type of LinkedIn search (default: people)"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Maximum number of results to return (default 5)"),
});

const linkedinSearchSkill: SkillDefinition = {
  name: "linkedin_search",
  version: "1.0.0",

  manifest: {
    id: "linkedin_search",
    name: "LinkedIn Search",
    description:
      "Search LinkedIn for people, companies, or jobs using Brave Search as a proxy. Returns profile URLs, titles, and descriptions.",
    category: "search",
    tools: ["linkedin_search"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "linkedin_search",
      description:
        "Search LinkedIn for people, companies, or jobs. Uses Brave Search with site:linkedin.com filtering. Requires BRAVE_API_KEY.",
      parameters: LinkedInSearchParams,

      async execute(params) {
        const apiKey = process.env.BRAVE_API_KEY;
        if (!apiKey) {
          return {
            error:
              "BRAVE_API_KEY environment variable is not set. LinkedIn search requires Brave Search API access.",
          };
        }

        const sitePath = LINKEDIN_PATHS[params.type] ?? "linkedin.com/in";
        const fullQuery = `site:${sitePath} ${params.query}`;

        const url = new URL(BRAVE_SEARCH_URL);
        url.searchParams.set("q", fullQuery);
        url.searchParams.set("count", String(params.maxResults));

        try {
          const response = await safeFetch(url.toString(), {
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "gzip",
              "X-Subscription-Token": apiKey,
            },
            ssrfProtection: false,
          });

          if (!response.ok) {
            return {
              error: `Brave Search API returned ${response.status}: ${response.statusText}`,
            };
          }

          const body = (await response.json()) as {
            web?: {
              results?: Array<{ title: string; url: string; description: string }>;
            };
          };
          const results = body.web?.results ?? [];

          return {
            query: params.query,
            type: params.type,
            resultCount: results.length,
            results: results.map((r) => ({
              title: r.title,
              url: r.url,
              description: r.description,
            })),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `LinkedIn search failed: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "linkedin_search",
      instructions:
        "You can search LinkedIn using the `linkedin_search` tool. Specify a query and type (people, companies, or jobs). Requires BRAVE_API_KEY.",
    };
  },
};

export default linkedinSearchSkill;
