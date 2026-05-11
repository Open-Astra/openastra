import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Tax Calculator Skill ────────────────────────────────────────────
// Estimates income tax, capital gains tax, and sales tax.
// Uses built-in US federal tax brackets (2025/2026).

const IncomeTaxParams = z.object({
  income: z.number().positive().describe("Annual gross income"),
  filingStatus: z.enum(["single", "married_joint", "married_separate", "head_of_household"]).default("single"),
  deductions: z.number().nonnegative().default(0).describe("Total deductions (0 = standard deduction)"),
  state: z.string().optional().describe("US state code for state tax estimate (e.g. CA, NY, TX)"),
});

const CapGainsParams = z.object({
  proceeds: z.number().positive().describe("Total sale proceeds"),
  costBasis: z.number().nonnegative().describe("Original cost basis"),
  holdingPeriod: z.enum(["short", "long"]).describe("Holding period (short < 1yr, long >= 1yr)"),
  income: z.number().nonnegative().default(0).describe("Ordinary income (for bracket determination)"),
});

const SalesTaxParams = z.object({
  amount: z.number().positive().describe("Purchase amount before tax"),
  rate: z.number().min(0).max(0.15).describe("Sales tax rate (e.g. 0.0875 for 8.75%)"),
});

// 2025 US federal brackets (single)
const BRACKETS_SINGLE = [
  { min: 0, max: 11_600, rate: 0.10 },
  { min: 11_600, max: 47_150, rate: 0.12 },
  { min: 47_150, max: 100_525, rate: 0.22 },
  { min: 100_525, max: 191_950, rate: 0.24 },
  { min: 191_950, max: 243_725, rate: 0.32 },
  { min: 243_725, max: 609_350, rate: 0.35 },
  { min: 609_350, max: Infinity, rate: 0.37 },
];

const STANDARD_DEDUCTION: Record<string, number> = {
  single: 14_600,
  married_joint: 29_200,
  married_separate: 14_600,
  head_of_household: 21_900,
};

// Approximate state income tax rates (flat or top marginal)
const STATE_RATES: Record<string, number> = {
  CA: 0.093, NY: 0.0685, TX: 0, FL: 0, WA: 0, NV: 0, IL: 0.0495,
  PA: 0.0307, OH: 0.04, NJ: 0.0675, MA: 0.05, CO: 0.044, GA: 0.055,
  NC: 0.0475, AZ: 0.025, VA: 0.0575, MN: 0.0985, OR: 0.099,
};

function computeFederalTax(taxableIncome: number): { tax: number; effectiveRate: number; brackets: Array<{ rate: number; taxed: number; tax: number }> } {
  let remaining = Math.max(0, taxableIncome);
  let total = 0;
  const details: Array<{ rate: number; taxed: number; tax: number }> = [];

  for (const bracket of BRACKETS_SINGLE) {
    const taxable = Math.min(remaining, bracket.max - bracket.min);
    if (taxable <= 0) break;
    const tax = taxable * bracket.rate;
    details.push({ rate: bracket.rate, taxed: Math.round(taxable), tax: Math.round(tax) });
    total += tax;
    remaining -= taxable;
  }

  return { tax: Math.round(total), effectiveRate: taxableIncome > 0 ? total / taxableIncome : 0, brackets: details };
}

const taxCalculatorSkill: SkillDefinition = {
  name: "tax_calculator",
  version: "1.0.0",

  manifest: {
    id: "tax_calculator",
    name: "Tax Calculator",
    description: "Estimate US federal income tax, capital gains tax, and sales tax. Includes state tax estimates.",
    category: "analyze",
    tools: ["tax_income", "tax_capital_gains", "tax_sales"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "tax_income",
      description: "Estimate US federal (and optional state) income tax for a given income and filing status.",
      parameters: IncomeTaxParams,

      async execute(params) {
        const standardDed = STANDARD_DEDUCTION[params.filingStatus] ?? 14_600;
        const deduction = params.deductions > 0 ? params.deductions : standardDed;
        const taxableIncome = Math.max(0, params.income - deduction);

        const federal = computeFederalTax(taxableIncome);

        let stateTax = 0;
        let stateRate = 0;
        if (params.state) {
          stateRate = STATE_RATES[params.state.toUpperCase()] ?? 0;
          stateTax = Math.round(taxableIncome * stateRate);
        }

        return {
          grossIncome: params.income,
          filingStatus: params.filingStatus,
          deduction,
          deductionType: params.deductions > 0 ? "itemized" : "standard",
          taxableIncome,
          federalTax: federal.tax,
          effectiveRate: Math.round(federal.effectiveRate * 10000) / 100,
          brackets: federal.brackets,
          state: params.state ?? null,
          stateTax,
          stateRate: Math.round(stateRate * 10000) / 100,
          totalTax: federal.tax + stateTax,
          afterTaxIncome: params.income - federal.tax - stateTax,
          note: "Estimates only. Consult a tax professional for actual filing.",
        };
      },
    });

    ctx.registerTool({
      name: "tax_capital_gains",
      description: "Estimate capital gains tax on an investment sale.",
      parameters: CapGainsParams,

      async execute(params) {
        const gain = params.proceeds - params.costBasis;
        if (gain <= 0) {
          return { gain, tax: 0, note: `Loss of $${Math.abs(gain).toFixed(2)} — no tax owed. Up to $3,000 can offset ordinary income.` };
        }

        let rate: number;
        if (params.holdingPeriod === "short") {
          // Short-term = ordinary income rates (estimate based on income + gain)
          const totalIncome = params.income + gain;
          const result = computeFederalTax(totalIncome);
          rate = result.effectiveRate;
        } else {
          // Long-term capital gains brackets (2025)
          const totalIncome = params.income + gain;
          if (totalIncome <= 47_025) rate = 0;
          else if (totalIncome <= 518_900) rate = 0.15;
          else rate = 0.20;
        }

        const tax = Math.round(gain * rate);
        return {
          proceeds: params.proceeds,
          costBasis: params.costBasis,
          gain,
          holdingPeriod: params.holdingPeriod,
          taxRate: Math.round(rate * 10000) / 100,
          estimatedTax: tax,
          netProceeds: params.proceeds - tax,
          note: "Estimate only. Does not include NIIT (3.8%) or state taxes.",
        };
      },
    });

    ctx.registerTool({
      name: "tax_sales",
      description: "Calculate sales tax for a purchase amount.",
      parameters: SalesTaxParams,

      async execute(params) {
        const tax = Math.round(params.amount * params.rate * 100) / 100;
        return {
          amount: params.amount,
          taxRate: `${(params.rate * 100).toFixed(2)}%`,
          salesTax: tax,
          total: Math.round((params.amount + tax) * 100) / 100,
        };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "tax_calculator",
      instructions: "You can estimate taxes with `tax_income` (federal + state income tax), `tax_capital_gains` (investment sale tax), and `tax_sales` (sales tax). Uses 2025 US federal brackets.",
    };
  },
};

export default taxCalculatorSkill;
