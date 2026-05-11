import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Web Scrape Skill ──────────────────────────────────────────────
// Fetches a URL and strips HTML tags to return plain text content.

function stripHtml(html: string): string {
  return html
    // Remove script and style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Replace common block elements with newlines
    .replace(/<\/(p|div|h[1-6]|li|tr|br\s*\/?)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    // Strip all remaining HTML tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Collapse whitespace
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const WebScrapeParams = z.object({
  url: z.string().url().describe("URL to fetch and extract text from"),
  maxLength: z.number().int().min(100).max(50000).default(5000).describe("Maximum character length of returned text (default 5000)"),
});

const webScrapeSkill: SkillDefinition = {
  name: "web_scrape",
  version: "1.0.0",

  manifest: {
    id: "web_scrape",
    name: "Web Scrape",
    description: "Fetches a web page and extracts plain text content by stripping HTML tags.",
    category: "search",
    tools: ["web_scrape"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "web_scrape",
      description: "Fetch a web page URL and return its content as plain text with HTML stripped.",
      parameters: WebScrapeParams,

      async execute(params) {
        try {
          const response = await safeFetch(params.url, {
            headers: {
              "User-Agent": "Astra-Agent/1.0",
              "Accept": "text/html,application/xhtml+xml,text/plain",
            },
            timeoutMs: 15_000,
          });

          if (!response.ok) {
            return { error: `HTTP ${response.status}: ${response.statusText}` };
          }

          const html = await response.text();
          let text = stripHtml(html);

          const truncated = text.length > params.maxLength;
          if (truncated) {
            text = text.slice(0, params.maxLength) + "...";
          }

          return {
            url: params.url,
            charCount: text.length,
            truncated,
            content: text,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `Failed to scrape URL: ${message}` };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "web_scrape",
      instructions: "You can fetch and read web pages using the `web_scrape` tool. It returns plain text content.",
    };
  },
};

export default webScrapeSkill;
