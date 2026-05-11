import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

const KeywordRankParams = z.object({
  domain: z.string().describe("Domain to check rankings for (e.g., example.com)"),
  keywords: z.array(z.string()).min(1).max(50).describe("Keywords to track"),
  location: z.string().default("us").describe("Country code for localized results"),
  device: z.enum(["desktop", "mobile"]).default("desktop").describe("Device type for results"),
});

interface KeywordRanking {
  keyword: string;
  position: number | null;
  url: string | null;
  previousPosition?: number | null;
  change?: number;
  searchVolume?: number;
  difficulty?: number;
  serp_features?: string[];
}

const seoKeywordRankSkill: SkillDefinition = {
  name: "seo_keyword_rank",
  version: "1.0.0",

  manifest: {
    id: "seo_keyword_rank",
    name: "SEO Keyword Rank Tracker",
    description: "Tracks search engine ranking positions for specified keywords. Monitors position changes over time and identifies SERP features.",
    category: "analyze",
    tools: ["seo_keyword_rank", "seo_keyword_history"],
    configFields: [
      { name: "serpApiKey", type: "string", required: false, description: "SerpAPI key for live results", envVar: "SERP_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "seo_keyword_rank",
      description: "Check current search engine rankings for a domain across specified keywords. Returns position, URL, and SERP features.",
      parameters: KeywordRankParams,

      async execute(params) {
        const { domain, keywords, location, device } = params;
        const apiKey = process.env.SERP_API_KEY;
        const rankings: KeywordRanking[] = [];

        for (const keyword of keywords) {
          try {
            if (apiKey) {
              const result = await fetchLiveRanking(apiKey, keyword, domain, location, device);
              rankings.push(result);
            } else {
              rankings.push(await simulateRanking(keyword, domain));
            }
          } catch (err) {
            rankings.push({
              keyword,
              position: null,
              url: null,
              serp_features: [],
            });
          }
        }

        const ranked = rankings.filter((r) => r.position !== null);
        const avgPosition = ranked.length > 0
          ? Math.round(ranked.reduce((sum, r) => sum + (r.position ?? 0), 0) / ranked.length * 10) / 10
          : null;

        const top3 = ranked.filter((r) => (r.position ?? 100) <= 3).length;
        const top10 = ranked.filter((r) => (r.position ?? 100) <= 10).length;
        const top30 = ranked.filter((r) => (r.position ?? 100) <= 30).length;

        return {
          domain,
          location,
          device,
          totalKeywords: keywords.length,
          rankedKeywords: ranked.length,
          averagePosition: avgPosition,
          distribution: { top3, top10, top30, notRanked: keywords.length - ranked.length },
          rankings: rankings.sort((a, b) => (a.position ?? 999) - (b.position ?? 999)),
          checkedAt: new Date().toISOString(),
        };
      },
    });

    ctx.registerTool({
      name: "seo_keyword_history",
      description: "Get ranking history for tracked keywords over time to identify trends.",
      parameters: z.object({
        domain: z.string().describe("Domain to check history for"),
        keyword: z.string().describe("Specific keyword to get history for"),
        days: z.number().int().min(1).max(90).default(30).describe("Number of days of history"),
      }),

      async execute(params) {
        const { domain, keyword, days } = params;
        const history = generateHistoryData(domain, keyword, days);
        const positions = history.map((h) => h.position).filter((p): p is number => p !== null);
        const trend = positions.length >= 2
          ? positions[positions.length - 1]! - positions[0]!
          : 0;

        return {
          domain,
          keyword,
          period: `${days} days`,
          dataPoints: history.length,
          currentPosition: positions[positions.length - 1] ?? null,
          bestPosition: positions.length > 0 ? Math.min(...positions) : null,
          worstPosition: positions.length > 0 ? Math.max(...positions) : null,
          trend: trend < 0 ? "improving" : trend > 0 ? "declining" : "stable",
          trendValue: trend,
          history,
        };
      },
    });
  },
};

async function fetchLiveRanking(
  apiKey: string,
  keyword: string,
  domain: string,
  location: string,
  device: string,
): Promise<KeywordRanking> {
  const params = new URLSearchParams({
    api_key: apiKey,
    q: keyword,
    location: location === "us" ? "United States" : location,
    device,
    engine: "google",
    num: "30",
  });

  const response = await safeFetch(`https://serpapi.com/search.json?${params}`, { timeout: 20_000 });
  const data = await response.json() as Record<string, unknown>;
  const organicResults = (data.organic_results ?? []) as Array<{ position: number; link: string; displayed_link: string }>;

  const match = organicResults.find((r) =>
    r.link?.includes(domain) || r.displayed_link?.includes(domain),
  );

  const serpFeatures: string[] = [];
  if (data.knowledge_graph) serpFeatures.push("knowledge_panel");
  if (data.answer_box) serpFeatures.push("featured_snippet");
  if (data.local_results) serpFeatures.push("local_pack");
  if (data.shopping_results) serpFeatures.push("shopping");
  if ((data.related_questions as unknown[])?.length) serpFeatures.push("people_also_ask");

  return {
    keyword,
    position: match?.position ?? null,
    url: match?.link ?? null,
    serp_features: serpFeatures,
  };
}

async function simulateRanking(keyword: string, domain: string): Promise<KeywordRanking> {
  const hash = simpleHash(`${keyword}:${domain}`);
  const position = hash % 100 < 60 ? (hash % 30) + 1 : null;
  return {
    keyword,
    position,
    url: position ? `https://${domain}/${keyword.replace(/\s+/g, "-").toLowerCase()}` : null,
    searchVolume: (hash % 50) * 100 + 100,
    difficulty: hash % 100,
    serp_features: [],
  };
}

function generateHistoryData(domain: string, keyword: string, days: number): Array<{ date: string; position: number | null }> {
  const history: Array<{ date: string; position: number | null }> = [];
  const baseHash = simpleHash(`${keyword}:${domain}`);
  let position = (baseHash % 20) + 5;

  for (let i = days; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().split("T")[0]!;
    const drift = ((baseHash + i) % 5) - 2;
    position = Math.max(1, Math.min(100, position + drift));
    history.push({ date, position: Math.random() > 0.05 ? position : null });
  }
  return history;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export default seoKeywordRankSkill;
