import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── arXiv Search Skill ────────────────────────────────────────────
// Search academic papers on arXiv. Free, no API key needed.
// Uses the arXiv API (Atom XML) and parses with regex.

const ARXIV_API = "http://export.arxiv.org/api/query";

const ArxivSearchParams = z.object({
  query: z.string().describe("Search query for arXiv papers"),
  maxResults: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .describe("Number of results to return (default 5, max 20)"),
});

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
  return match?.[1]?.trim() ?? "";
}

function extractAllTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractAttribute(xml: string, tag: string, attr: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(`<${tag}[^>]*?${attr}="([^"]*)"`, "g");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

function extractLinks(entryXml: string): string {
  // Get the main PDF or abstract link
  const pdfMatch = entryXml.match(
    /<link[^>]*title="pdf"[^>]*href="([^"]*)"/,
  );
  if (pdfMatch) return pdfMatch[1];

  const absMatch = entryXml.match(
    /<link[^>]*type="text\/html"[^>]*href="([^"]*)"/,
  );
  if (absMatch) return absMatch[1];

  // Fallback: first link href
  const anyMatch = entryXml.match(/<link[^>]*href="([^"]*)"/);
  return anyMatch?.[1] ?? "";
}

function parseArxivEntries(xml: string) {
  const entries: Array<{
    title: string;
    authors: string[];
    summary: string;
    published: string;
    link: string;
    categories: string[];
  }> = [];

  const entryBlocks = xml.split("<entry>").slice(1);
  for (const block of entryBlocks) {
    const entryXml = block.split("</entry>")[0] ?? block;

    const title = extractTag(entryXml, "title").replace(/\s+/g, " ");
    const authors = extractAllTags(entryXml, "name");
    const summary = extractTag(entryXml, "summary").replace(/\s+/g, " ");
    const published = extractTag(entryXml, "published");
    const link = extractLinks(entryXml);
    const categories = extractAttribute(entryXml, "category", "term");

    entries.push({ title, authors, summary, published, link, categories });
  }

  return entries;
}

const arxivSearchSkill: SkillDefinition = {
  name: "arxiv_search",
  version: "1.0.0",

  manifest: {
    id: "arxiv_search",
    name: "arXiv Search",
    description:
      "Search academic papers on arXiv. Free, no API key needed. Returns titles, authors, summaries, and links.",
    category: "search",
    tools: ["arxiv_search"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "arxiv_search",
      description:
        "Search arXiv for academic papers. Returns title, authors, summary, published date, link, and categories.",
      parameters: ArxivSearchParams,

      async execute(params) {
        const url = new URL(ARXIV_API);
        url.searchParams.set("search_query", `all:${params.query}`);
        url.searchParams.set("start", "0");
        url.searchParams.set("max_results", String(params.maxResults));
        url.searchParams.set("sortBy", "relevance");
        url.searchParams.set("sortOrder", "descending");

        const response = await safeFetch(url.toString(), {
          headers: { Accept: "application/xml" },
          ssrfProtection: false,
          timeoutMs: 15_000,
        });

        if (!response.ok) {
          return {
            error: `arXiv API returned ${response.status}: ${response.statusText}`,
          };
        }

        const xml = await response.text();
        const entries = parseArxivEntries(xml);

        return {
          query: params.query,
          resultCount: entries.length,
          results: entries.map((e) => ({
            title: e.title,
            authors: e.authors,
            summary:
              e.summary.length > 500
                ? e.summary.slice(0, 500) + "..."
                : e.summary,
            published: e.published,
            link: e.link,
            categories: e.categories,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "arxiv_search",
      instructions:
        "You can search for academic papers on arXiv using the `arxiv_search` tool. Provide a query and optionally the number of results (1-20, default 5). Returns titles, authors, summaries, publication dates, links, and categories.",
    };
  },
};

export default arxivSearchSkill;
