import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Sitemap Crawler Skill ────────────────────────────────────────
// Fetches and parses XML sitemaps to extract URLs, last modified
// dates, and priorities. Supports sitemap index files.

const SitemapCrawlerParams = z.object({
  url: z.string().url().describe("Sitemap URL or website URL (will try /sitemap.xml if not a sitemap)"),
  maxUrls: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum number of URLs to return (default 50, max 200)"),
  filter: z
    .string()
    .optional()
    .describe("Regex pattern to filter URLs (e.g. '/blog/' to only include blog pages)"),
});

interface SitemapEntry {
  loc: string;
  lastmod?: string;
  priority?: string;
  changefreq?: string;
}

function extractSitemapEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const urlRegex = /<url>([\s\S]*?)<\/url>/g;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(xml)) !== null) {
    const block = match[1];
    const loc = block.match(/<loc>([\s\S]*?)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;

    const lastmod = block.match(/<lastmod>([\s\S]*?)<\/lastmod>/)?.[1]?.trim();
    const priority = block.match(/<priority>([\s\S]*?)<\/priority>/)?.[1]?.trim();
    const changefreq = block.match(/<changefreq>([\s\S]*?)<\/changefreq>/)?.[1]?.trim();

    entries.push({
      loc: decodeXmlEntities(loc),
      ...(lastmod && { lastmod }),
      ...(priority && { priority }),
      ...(changefreq && { changefreq }),
    });
  }

  return entries;
}

function extractSitemapIndexUrls(xml: string): string[] {
  const urls: string[] = [];
  const sitemapRegex = /<sitemap>([\s\S]*?)<\/sitemap>/g;
  let match: RegExpExecArray | null;

  while ((match = sitemapRegex.exec(xml)) !== null) {
    const loc = match[1].match(/<loc>([\s\S]*?)<\/loc>/)?.[1]?.trim();
    if (loc) urls.push(decodeXmlEntities(loc));
  }

  return urls;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

function decodeXmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSitemapUrl(url: string): string {
  // If URL already looks like a sitemap, return as-is
  if (/sitemap.*\.xml/i.test(url)) return url;
  // Strip trailing slash and append /sitemap.xml
  return url.replace(/\/+$/, "") + "/sitemap.xml";
}

async function fetchSitemap(url: string): Promise<{ xml: string; finalUrl: string } | { error: string }> {
  try {
    const response = await safeFetch(url, {
      timeoutMs: 15_000,
      maxRetries: 1,
      ssrfProtection: false,
    });

    if (!response.ok) {
      return { error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const xml = await response.text();

    // Verify it looks like XML
    if (!xml.includes("<") || (!xml.includes("<urlset") && !xml.includes("<sitemapindex"))) {
      return { error: `Response from ${url} does not appear to be a valid XML sitemap.` };
    }

    return { xml, finalUrl: url };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `Failed to fetch ${url}: ${message}` };
  }
}

const sitemapCrawlerSkill: SkillDefinition = {
  name: "sitemap_crawler",
  version: "1.0.0",

  manifest: {
    id: "sitemap_crawler",
    name: "Sitemap Crawler",
    description:
      "Fetches and parses XML sitemaps to extract URLs, last modified dates, and priorities. Supports sitemap index files with nested sitemaps.",
    category: "search",
    tools: ["sitemap_crawler"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "sitemap_crawler",
      description:
        "Fetch and parse an XML sitemap. Extracts URLs with metadata (lastmod, priority). Supports sitemap index files. If given a website URL, automatically tries /sitemap.xml.",
      parameters: SitemapCrawlerParams,

      async execute(params) {
        const { url, maxUrls, filter } = params;
        let filterRegex: RegExp | undefined;

        if (filter) {
          try {
            filterRegex = new RegExp(filter, "i");
          } catch {
            return { error: `Invalid filter regex: "${filter}"` };
          }
        }

        // Try fetching the provided URL first
        let result = await fetchSitemap(url);

        // If that fails and URL doesn't look like a sitemap, try /sitemap.xml
        if ("error" in result && !/sitemap.*\.xml/i.test(url)) {
          const sitemapUrl = normalizeSitemapUrl(url);
          result = await fetchSitemap(sitemapUrl);

          if ("error" in result) {
            // Also try /sitemap_index.xml as a common alternative
            const indexUrl = url.replace(/\/+$/, "") + "/sitemap_index.xml";
            result = await fetchSitemap(indexUrl);
          }
        }

        if ("error" in result) {
          return result;
        }

        const { xml, finalUrl } = result;
        let allEntries: SitemapEntry[] = [];

        if (isSitemapIndex(xml)) {
          // It's a sitemap index — fetch child sitemaps
          const childUrls = extractSitemapIndexUrls(xml);

          // Fetch child sitemaps (up to 10 to avoid overwhelming)
          const maxChildren = Math.min(childUrls.length, 10);
          const childPromises = childUrls.slice(0, maxChildren).map((childUrl) => fetchSitemap(childUrl));
          const childResults = await Promise.allSettled(childPromises);

          for (const childResult of childResults) {
            if (childResult.status === "fulfilled" && !("error" in childResult.value)) {
              const entries = extractSitemapEntries(childResult.value.xml);
              allEntries.push(...entries);
              if (allEntries.length >= maxUrls) break;
            }
          }
        } else {
          allEntries = extractSitemapEntries(xml);
        }

        // Apply filter
        if (filterRegex) {
          allEntries = allEntries.filter((entry) => filterRegex!.test(entry.loc));
        }

        // Trim to maxUrls
        const trimmedEntries = allEntries.slice(0, maxUrls);

        return {
          sitemapUrl: finalUrl,
          isSitemapIndex: isSitemapIndex(xml),
          totalFound: allEntries.length,
          returned: trimmedEntries.length,
          filter: filter ?? null,
          urls: trimmedEntries,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "sitemap_crawler",
      instructions:
        "You can fetch and parse XML sitemaps using the `sitemap_crawler` tool. Provide a sitemap URL or website URL and optionally filter results with a regex pattern.",
    };
  },
};

export default sitemapCrawlerSkill;
