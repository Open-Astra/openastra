import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Stock Lookup Skill ──────────────────────────────────────────────
// Real-time and historical stock data via Alpha Vantage or compatible API.
// Requires STOCK_API_KEY (Alpha Vantage key) or STOCK_API_URL for proxy.

const QuoteParams = z.object({
  symbol: z.string().describe("Stock ticker symbol (e.g. AAPL, MSFT, TSLA)"),
});

const HistoryParams = z.object({
  symbol: z.string().describe("Stock ticker symbol"),
  interval: z.enum(["daily", "weekly", "monthly"]).default("daily").describe("Data interval"),
  limit: z.number().int().min(1).max(100).default(30).describe("Number of data points"),
});

const SearchParams = z.object({
  query: z.string().describe("Company name or partial symbol to search"),
});

const stockLookupSkill: SkillDefinition = {
  name: "stock_lookup",
  version: "1.0.0",

  manifest: {
    id: "stock_lookup",
    name: "Stock Lookup",
    description: "Real-time stock quotes, historical price data, and symbol search via Alpha Vantage API.",
    category: "search",
    tools: ["stock_quote", "stock_history", "stock_search"],
    configFields: [
      { name: "apiKey", type: "string", required: true, description: "Alpha Vantage API key", envVar: "STOCK_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const baseUrl = () => process.env.STOCK_API_URL ?? "https://www.alphavantage.co/query";
    const apiKey = () => process.env.STOCK_API_KEY ?? "";

    ctx.registerTool({
      name: "stock_quote",
      description: "Get a real-time stock quote with price, change, volume, and market cap.",
      parameters: QuoteParams,

      async execute(params) {
        const key = apiKey();
        if (!key) return { error: "STOCK_API_KEY not configured." };

        const url = `${baseUrl()}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(params.symbol)}&apikey=${key}`;
        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `API returned ${res.status}` };

        const data = (await res.json()) as { "Global Quote"?: Record<string, string> };
        const q = data["Global Quote"];
        if (!q || !q["01. symbol"]) return { error: `No quote found for ${params.symbol}` };

        return {
          symbol: q["01. symbol"],
          price: parseFloat(q["05. price"] ?? "0"),
          change: parseFloat(q["09. change"] ?? "0"),
          changePercent: q["10. change percent"] ?? "0%",
          volume: parseInt(q["06. volume"] ?? "0", 10),
          high: parseFloat(q["03. high"] ?? "0"),
          low: parseFloat(q["04. low"] ?? "0"),
          previousClose: parseFloat(q["08. previous close"] ?? "0"),
          latestTradingDay: q["07. latest trading day"],
        };
      },
    });

    ctx.registerTool({
      name: "stock_history",
      description: "Get historical stock price data (daily, weekly, or monthly).",
      parameters: HistoryParams,

      async execute(params) {
        const key = apiKey();
        if (!key) return { error: "STOCK_API_KEY not configured." };

        const fnMap = { daily: "TIME_SERIES_DAILY", weekly: "TIME_SERIES_WEEKLY", monthly: "TIME_SERIES_MONTHLY" };
        const url = `${baseUrl()}?function=${fnMap[params.interval]}&symbol=${encodeURIComponent(params.symbol)}&apikey=${key}`;
        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `API returned ${res.status}` };

        const data = (await res.json()) as Record<string, Record<string, Record<string, string>>>;
        const seriesKey = Object.keys(data).find((k) => k.includes("Time Series"));
        if (!seriesKey) return { error: "No time series data found." };

        const series = data[seriesKey]!;
        const dates = Object.keys(series).slice(0, params.limit);

        return {
          symbol: params.symbol,
          interval: params.interval,
          dataPoints: dates.length,
          history: dates.map((date) => ({
            date,
            open: parseFloat(series[date]!["1. open"] ?? "0"),
            high: parseFloat(series[date]!["2. high"] ?? "0"),
            low: parseFloat(series[date]!["3. low"] ?? "0"),
            close: parseFloat(series[date]!["4. close"] ?? "0"),
            volume: parseInt(series[date]!["5. volume"] ?? "0", 10),
          })),
        };
      },
    });

    ctx.registerTool({
      name: "stock_search",
      description: "Search for stock symbols by company name or partial symbol.",
      parameters: SearchParams,

      async execute(params) {
        const key = apiKey();
        if (!key) return { error: "STOCK_API_KEY not configured." };

        const url = `${baseUrl()}?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(params.query)}&apikey=${key}`;
        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `API returned ${res.status}` };

        const data = (await res.json()) as { bestMatches?: Array<Record<string, string>> };
        const matches = data.bestMatches ?? [];

        return {
          query: params.query,
          count: matches.length,
          results: matches.map((m) => ({
            symbol: m["1. symbol"],
            name: m["2. name"],
            type: m["3. type"],
            region: m["4. region"],
            currency: m["8. currency"],
          })),
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "stock_lookup",
      instructions: "You can look up stocks with `stock_quote` (real-time price), `stock_history` (historical data), and `stock_search` (find symbols). Requires STOCK_API_KEY.",
    };
  },
};

export default stockLookupSkill;
