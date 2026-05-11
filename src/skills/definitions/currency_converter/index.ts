import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { safeFetch } from "../../helpers/http.js";

// ── Currency Converter Skill ────────────────────────────────────────
// Foreign exchange rates and conversion via exchangerate-api or similar.
// Uses EXCHANGE_RATE_API_KEY or defaults to free tier.

const ConvertParams = z.object({
  amount: z.number().positive().describe("Amount to convert"),
  from: z.string().length(3).describe("Source currency code (e.g. USD, EUR, GBP)"),
  to: z.string().length(3).describe("Target currency code"),
});

const RatesParams = z.object({
  base: z.string().length(3).default("USD").describe("Base currency code"),
  targets: z.array(z.string().length(3)).optional().describe("Specific currencies to include (default: all)"),
});

const currencyConverterSkill: SkillDefinition = {
  name: "currency_converter",
  version: "1.0.0",

  manifest: {
    id: "currency_converter",
    name: "Currency Converter",
    description: "Convert between 170+ currencies with real-time exchange rates.",
    category: "transform",
    tools: ["currency_convert", "currency_rates"],
    configFields: [
      { name: "apiKey", type: "string", required: false, description: "Exchange Rate API key", envVar: "EXCHANGE_RATE_API_KEY" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    const getBaseUrl = () => {
      const key = process.env.EXCHANGE_RATE_API_KEY;
      return key
        ? `https://v6.exchangerate-api.com/v6/${key}`
        : "https://open.er-api.com/v6";
    };

    ctx.registerTool({
      name: "currency_convert",
      description: "Convert an amount from one currency to another using real-time exchange rates.",
      parameters: ConvertParams,

      async execute(params) {
        const from = params.from.toUpperCase();
        const to = params.to.toUpperCase();
        const url = `${getBaseUrl()}/pair/${from}/${to}/${params.amount}`;

        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `Exchange rate API returned ${res.status}` };

        const data = (await res.json()) as { result: string; conversion_rate?: number; conversion_result?: number };
        if (data.result !== "success") return { error: "Currency conversion failed." };

        return {
          from,
          to,
          amount: params.amount,
          rate: data.conversion_rate,
          converted: data.conversion_result,
        };
      },
    });

    ctx.registerTool({
      name: "currency_rates",
      description: "Get exchange rates for a base currency against all or specific target currencies.",
      parameters: RatesParams,

      async execute(params) {
        const base = params.base.toUpperCase();
        const url = `${getBaseUrl()}/latest/${base}`;

        const res = await safeFetch(url, { ssrfProtection: false });
        if (!res.ok) return { error: `Exchange rate API returned ${res.status}` };

        const data = (await res.json()) as { result: string; rates?: Record<string, number>; time_last_update_utc?: string };
        if (data.result !== "success" || !data.rates) return { error: "Failed to fetch rates." };

        let rates = data.rates;
        if (params.targets?.length) {
          const targets = new Set(params.targets.map((t) => t.toUpperCase()));
          rates = Object.fromEntries(Object.entries(rates).filter(([k]) => targets.has(k)));
        }

        return {
          base,
          lastUpdate: data.time_last_update_utc,
          currencyCount: Object.keys(rates).length,
          rates,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "currency_converter",
      instructions: "You can convert currencies with `currency_convert` (amount from one to another) and `currency_rates` (get all rates for a base currency). Supports 170+ currencies.",
    };
  },
};

export default currencyConverterSkill;
