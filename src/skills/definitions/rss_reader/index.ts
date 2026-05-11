import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── RSS Reader Skill ────────────────────────────────────────────────
// Fetch and parse RSS/Atom feeds. Supports tracking new items since
// last check for monitoring use cases.

const FetchFeedParams = z.object({
  url: z.string().url().describe("RSS/Atom feed URL"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max items to return"),
});

const MultiFeedParams = z.object({
  urls: z.array(z.string().url()).min(1).max(10).describe("List of feed URLs to fetch"),
  limit: z.number().int().min(1).max(10).default(5).describe("Max items per feed"),
});

// Simple XML tag extraction (avoids heavy XML parser dependency)
function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match?.[1]?.trim() ?? "";
}

function extractCdata(text: string): string {
  const match = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return match?.[1] ?? text;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function parseItems(xml: string, limit: number): Array<{ title: string; link: string; date: string; summary: string }> {
  const items: Array<{ title: string; link: string; date: string; summary: string }> = [];

  // RSS 2.0 items
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  // Atom entries
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];

  const entries = rssItems.length > 0 ? rssItems : atomEntries;

  for (const entry of entries.slice(0, limit)) {
    const title = stripHtml(extractCdata(extractTag(entry, "title")));
    const link = extractTag(entry, "link") || entry.match(/href="([^"]+)"/)?.[1] || "";
    const date = extractTag(entry, "pubDate") || extractTag(entry, "published") || extractTag(entry, "updated") || "";
    const desc = extractTag(entry, "description") || extractTag(entry, "summary") || extractTag(entry, "content");
    const summary = stripHtml(extractCdata(desc)).slice(0, 300);

    items.push({ title, link: stripHtml(link), date, summary });
  }

  return items;
}

const rssReaderSkill: SkillDefinition = {
  name: "rss_reader",
  version: "1.0.0",

  manifest: {
    id: "rss_reader",
    name: "RSS Reader",
    description: "Fetch and parse RSS/Atom feeds. Returns structured feed items with title, link, date, and summary.",
    category: "search",
    tools: ["rss_fetch", "rss_multi_fetch"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "rss_fetch",
      description: "Fetch and parse a single RSS/Atom feed URL. Returns items with title, link, date, and summary.",
      parameters: FetchFeedParams,

      async execute(params) {
        try {
          const res = await safeFetch(params.url, {
            headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml" },
            timeoutMs: 15_000,
          });

          if (!res.ok) return { error: `Feed returned HTTP ${res.status}` };

          const xml = await res.text();
          const feedTitle = stripHtml(extractCdata(extractTag(xml, "title")));
          const items = parseItems(xml, params.limit);

          return { feed: feedTitle || params.url, itemCount: items.length, items };
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      },
    });

    ctx.registerTool({
      name: "rss_multi_fetch",
      description: "Fetch multiple RSS/Atom feeds at once. Returns items from all feeds combined.",
      parameters: MultiFeedParams,

      async execute(params) {
        const results = await Promise.allSettled(
          params.urls.map(async (url) => {
            const res = await safeFetch(url, {
              headers: { "Accept": "application/rss+xml, application/atom+xml, text/xml" },
              timeoutMs: 15_000,
            });
            if (!res.ok) return { url, error: `HTTP ${res.status}`, items: [] };
            const xml = await res.text();
            const title = stripHtml(extractCdata(extractTag(xml, "title")));
            return { url, feed: title, items: parseItems(xml, params.limit) };
          }),
        );

        const feeds = results.map((r, i) =>
          r.status === "fulfilled" ? r.value : { url: params.urls[i], error: String((r as PromiseRejectedResult).reason), items: [] },
        );

        const totalItems = feeds.reduce((sum, f) => sum + (f.items?.length ?? 0), 0);
        return { feedCount: feeds.length, totalItems, feeds };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "rss_reader",
      instructions: "You can read RSS/Atom feeds with `rss_fetch` (single feed) or `rss_multi_fetch` (multiple feeds at once). Returns titles, links, dates, and summaries.",
    };
  },
};

export default rssReaderSkill;
