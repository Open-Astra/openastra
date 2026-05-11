import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Crypto Tracker Skill ────────────────────────────────────────────
// Cryptocurrency prices, market data, and trending coins via
// CoinGecko API (free tier, no key required for basic endpoints).

const COINGECKO_API = "https://api.coingecko.com/api/v3";

const PriceParams = z.object({
  ids: z.array(z.string()).min(1).max(20).describe("CoinGecko coin IDs (e.g. ['bitcoin', 'ethereum'])"),
  currency: z.string().default("usd").describe("Quote currency (default: usd)"),
});

const CoinInfoParams = z.object({
  id: z.string().describe("CoinGecko coin ID (e.g. 'bitcoin')"),
});

const TrendingParams = z.object({});

const cryptoTrackerSkill: SkillDefinition = {
  name: "crypto_tracker",
  version: "1.0.0",

  manifest: {
    id: "crypto_tracker",
    name: "Crypto Tracker",
    description: "Cryptocurrency prices, market data, and trending coins via CoinGecko API.",
    category: "search",
    tools: ["crypto_price", "crypto_info", "crypto_trending"],
    configFields: [
      { name: "apiKey", type: "string", required: false, description: "CoinGecko Pro API key (optional)", envVar: "COINGECKO_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const headers = (): Record<string, string> => {
      const key = process.env.COINGECKO_API_KEY;
      return key ? { "x-cg-pro-api-key": key } : {};
    };

    ctx.registerTool({
      name: "crypto_price",
      description: "Get current prices for one or more cryptocurrencies. Includes 24h change, market cap, and volume.",
      parameters: PriceParams,

      async execute(params) {
        const url = `${COINGECKO_API}/simple/price?ids=${params.ids.join(",")}&vs_currencies=${params.currency}&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`;
        const res = await safeFetch(url, { headers: headers(), ssrfProtection: false });
        if (!res.ok) return { error: `CoinGecko API returned ${res.status}` };

        const data = (await res.json()) as Record<string, Record<string, number>>;
        const currency = params.currency;

        return {
          currency,
          prices: Object.entries(data).map(([id, values]) => ({
            id,
            price: values[currency],
            change24h: values[`${currency}_24h_change`],
            marketCap: values[`${currency}_market_cap`],
            volume24h: values[`${currency}_24h_vol`],
          })),
        };
      },
    });

    ctx.registerTool({
      name: "crypto_info",
      description: "Get detailed information about a specific cryptocurrency including description, links, and market data.",
      parameters: CoinInfoParams,

      async execute(params) {
        const url = `${COINGECKO_API}/coins/${encodeURIComponent(params.id)}?localization=false&tickers=false&community_data=false&developer_data=false`;
        const res = await safeFetch(url, { headers: headers(), ssrfProtection: false });
        if (!res.ok) return { error: `CoinGecko API returned ${res.status}` };

        const data = (await res.json()) as {
          id: string; symbol: string; name: string;
          description?: { en?: string };
          market_data?: { current_price?: Record<string, number>; market_cap?: Record<string, number>; total_volume?: Record<string, number>; price_change_percentage_24h?: number; ath?: Record<string, number>; circulating_supply?: number };
          categories?: string[];
        };

        return {
          id: data.id,
          symbol: data.symbol,
          name: data.name,
          description: data.description?.en?.slice(0, 500),
          categories: data.categories?.slice(0, 5),
          marketData: {
            priceUsd: data.market_data?.current_price?.usd,
            marketCapUsd: data.market_data?.market_cap?.usd,
            volume24hUsd: data.market_data?.total_volume?.usd,
            change24h: data.market_data?.price_change_percentage_24h,
            athUsd: data.market_data?.ath?.usd,
            circulatingSupply: data.market_data?.circulating_supply,
          },
        };
      },
    });

    ctx.registerTool({
      name: "crypto_trending",
      description: "Get trending cryptocurrencies on CoinGecko (top 7 most searched).",
      parameters: TrendingParams,

      async execute() {
        const res = await safeFetch(`${COINGECKO_API}/search/trending`, { headers: headers(), ssrfProtection: false });
        if (!res.ok) return { error: `CoinGecko API returned ${res.status}` };

        const data = (await res.json()) as { coins?: Array<{ item: { id: string; coin_id: number; name: string; symbol: string; market_cap_rank: number; price_btc: number } }> };
        return {
          trending: (data.coins ?? []).map((c) => ({
            id: c.item.id,
            name: c.item.name,
            symbol: c.item.symbol,
            marketCapRank: c.item.market_cap_rank,
            priceBtc: c.item.price_btc,
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "crypto_tracker",
      instructions: "You can track crypto with `crypto_price` (current prices for multiple coins), `crypto_info` (detailed coin data), and `crypto_trending` (trending coins). Uses CoinGecko API.",
    };
  },
};

export default cryptoTrackerSkill;
