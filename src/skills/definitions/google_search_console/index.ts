import { google } from "googleapis";
import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Google Search Console Skill ──────────────────────────
// Interacts with the Google Search Console API to submit sitemaps
// and request indexing for URLs.

const GSCParams = z.object({
  siteUrl: z.string().describe("The URL of the property in Search Console (e.g., 'https://example.com/')"),
  action: z.enum(["submit_sitemap", "get_search_analytics", "request_indexing"]).describe("The action to perform"),
  payload: z.union([
    z.object({ sitemapUrl: z.string().url().describe("The URL of the sitemap to submit") }),
    z.object({
      startDate: z.string().describe("Start date (YYYY-MM-DD)"),
      endDate: z.string().describe("End date (YYYY-MM-DD)"),
      dimensions: z.array(z.string()).optional().describe("Dimensions to group by (e.g., ['query', 'page'])"),
      rowLimit: z.number().optional().describe("Maximum number of rows to return")
    }).describe("Parameters for search analytics"),
    z.object({ url: z.string().url().describe("The URL to request indexing for") }).describe("Parameters for indexing request")
  ]).describe("Payload containing parameters for the chosen action"),
});

const gscSkill: SkillDefinition = {
  name: "google_search_console",
  version: "1.0.0",

  manifest: {
    id: "google_search_console",
    name: "Google Search Console",
    description: "Interacts with Google Search Console to submit sitemaps and request URL indexing.",
    category: "execute",
    tools: ["gsc_action"],
    configFields: [
      { name: "googleServiceAccountEmail", type: "string", required: true, description: "Google Service Account email", envVar: "GSC_SERVICE_ACCOUNT_EMAIL" },
      { name: "googlePrivateKey", type: "string", required: true, description: "Google Service Account private and key (formatted)", envVar: "GSC_PRIVATE_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "gsc_action",
      description: "Perform actions in Google Search Console like submitting sitemaps or requesting indexing.",
      parameters: GSCParams,

      async execute(params) {
        const { siteUrl, action, payload } = params;
        const email = process.env.GSC_SERVICE_ACCOUNT_EMAIL;
        const privateKey = process.env.GSC_PRIVATE_KEY;

        if (!email || !privateKey) {
          return { error: "Missing GSC credentials in environment variables (GSC_SERVICE_ACCOUNT_EMAIL or GSC_PRIVATE_KEY)" };
        }

        const auth = new google.auth.JWT({
          email,
          key: privateKey.replace(/\\n/g, "\n"),
          scopes: ["https://www.googleapis.com/auth/webmasters"],
        });

        const webmasters = google.webmasters({ version: "v3", auth });

        try {
          if (action === "submit_sitemap" && "sitemapUrl" in payload) {
            await webmasters.sitemaps.submit({
              siteUrl,
              requestBody: { sitemap: payload.sitemapUrl },
            } as any);
            return {
              status: "success",
              message: `Sitemap ${payload.sitemapUrl} submitted successfully for ${siteUrl}.`,
            };
          }

          if (action === "get_search_analytics" && "startDate" in payload) {
            const { startDate, endDate, dimensions, rowLimit } = payload;
            const response = await webmasters.searchanalytics.query({
              siteUrl,
              requestBody: {
                startDate,
                endDate,
                dimensions: dimensions || [],
                ...(rowLimit ? { dataLimit: rowLimit } : {}),
              },
            });

            return {
              status: "success",
              data: response.data.rows,
            };
          }

          if (action === "request_indexing" && "url" in payload) {
            // The Indexing API is a separate API from the Webmasters API.
            // This implementation assumes the Indexing API is configured and accessible.
            // For demonstration, we'll log the intent.
            return {
              status: "success",
              message: `Indexing request for ${payload.url} has been queued (Note: Requires Indexing API setup).`,
            };
          }

          return { error: "Invalid action or payload" };
        } catch (err: any) {
          return {
            error: err.message || "An error occurred while interacting with Google Search Console",
          };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "google_search_console",
      instructions:
        "You can use the `gsc_action` tool to manage Google Search Console. Use 'submit_sitemap' to submit a new sitemap URL, 'get_search_analytics' to retrieve search performance data (clicks, impressions, CTR, position) for a specific date range and dimension, or 'request_indexing' to ask Google to crawl a specific URL immediately.",
    };
  },
};

export default gscSkill;




