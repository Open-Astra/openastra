import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Statistics Skill ────────────────────────────────────────────────
// Statistical analysis: descriptive stats, correlation, regression,
// percentiles, and distribution analysis.

const DescriptiveParams = z.object({
  values: z.array(z.number()).min(1).describe("Array of numeric values"),
  label: z.string().optional().describe("Label for the dataset"),
});

const CorrelationParams = z.object({
  x: z.array(z.number()).min(2).describe("X values"),
  y: z.array(z.number()).min(2).describe("Y values (same length as X)"),
});

const RegressionParams = z.object({
  x: z.array(z.number()).min(2).describe("Independent variable values"),
  y: z.array(z.number()).min(2).describe("Dependent variable values"),
  predictX: z.array(z.number()).optional().describe("X values to predict Y for"),
});

const PercentilesParams = z.object({
  values: z.array(z.number()).min(1).describe("Array of numeric values"),
  percentiles: z.array(z.number().min(0).max(100)).default([25, 50, 75, 90, 95, 99]).describe("Percentiles to calculate"),
});

function round(n: number, decimals = 4): number {
  return Math.round(n * 10 ** decimals) / 10 ** decimals;
}

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (idx - lower);
}

const statisticsSkill: SkillDefinition = {
  name: "statistics",
  version: "1.0.0",

  manifest: {
    id: "statistics",
    name: "Statistics",
    description: "Statistical analysis: descriptive stats, correlation, linear regression, percentiles.",
    category: "analyze",
    tools: ["stats_descriptive", "stats_correlation", "stats_regression", "stats_percentiles"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "stats_descriptive",
      description: "Calculate descriptive statistics: mean, median, mode, std dev, variance, skewness, range.",
      parameters: DescriptiveParams,

      async execute(params) {
        const v = params.values;
        const n = v.length;
        const sorted = [...v].sort((a, b) => a - b);
        const sum = v.reduce((a, b) => a + b, 0);
        const mean = sum / n;
        const median = n % 2 === 0 ? (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2 : sorted[Math.floor(n / 2)]!;

        // Mode
        const freq = new Map<number, number>();
        for (const val of v) freq.set(val, (freq.get(val) ?? 0) + 1);
        let maxFreq = 0;
        let mode: number[] = [];
        for (const [val, count] of freq) {
          if (count > maxFreq) { maxFreq = count; mode = [val]; }
          else if (count === maxFreq) mode.push(val);
        }

        const variance = v.reduce((acc, val) => acc + (val - mean) ** 2, 0) / (n - 1 || 1);
        const stdDev = Math.sqrt(variance);

        // Skewness
        const skewness = n >= 3 ? (v.reduce((acc, val) => acc + ((val - mean) / stdDev) ** 3, 0) * n) / ((n - 1) * (n - 2)) : 0;

        return {
          label: params.label ?? "dataset",
          count: n,
          sum: round(sum),
          mean: round(mean),
          median: round(median),
          mode: mode.length === n ? null : mode,
          min: sorted[0],
          max: sorted[n - 1],
          range: round(sorted[n - 1]! - sorted[0]!),
          variance: round(variance),
          stdDev: round(stdDev),
          skewness: round(skewness),
          q1: round(percentile(sorted, 25)),
          q3: round(percentile(sorted, 75)),
          iqr: round(percentile(sorted, 75) - percentile(sorted, 25)),
        };
      },
    });

    ctx.registerTool({
      name: "stats_correlation",
      description: "Calculate Pearson correlation coefficient between two datasets.",
      parameters: CorrelationParams,

      async execute(params) {
        const n = Math.min(params.x.length, params.y.length);
        if (n < 2) return { error: "Need at least 2 data points." };

        const x = params.x.slice(0, n);
        const y = params.y.slice(0, n);
        const meanX = x.reduce((a, b) => a + b, 0) / n;
        const meanY = y.reduce((a, b) => a + b, 0) / n;

        let sumXY = 0, sumX2 = 0, sumY2 = 0;
        for (let i = 0; i < n; i++) {
          const dx = x[i]! - meanX;
          const dy = y[i]! - meanY;
          sumXY += dx * dy;
          sumX2 += dx * dx;
          sumY2 += dy * dy;
        }

        const r = sumX2 > 0 && sumY2 > 0 ? sumXY / Math.sqrt(sumX2 * sumY2) : 0;
        const r2 = r * r;

        let interpretation: string;
        const absR = Math.abs(r);
        if (absR >= 0.8) interpretation = "strong";
        else if (absR >= 0.5) interpretation = "moderate";
        else if (absR >= 0.3) interpretation = "weak";
        else interpretation = "negligible";

        return {
          n,
          correlation: round(r),
          rSquared: round(r2),
          direction: r > 0 ? "positive" : r < 0 ? "negative" : "none",
          strength: interpretation,
        };
      },
    });

    ctx.registerTool({
      name: "stats_regression",
      description: "Perform simple linear regression (y = mx + b). Optionally predict Y for given X values.",
      parameters: RegressionParams,

      async execute(params) {
        const n = Math.min(params.x.length, params.y.length);
        if (n < 2) return { error: "Need at least 2 data points." };

        const x = params.x.slice(0, n);
        const y = params.y.slice(0, n);
        const meanX = x.reduce((a, b) => a + b, 0) / n;
        const meanY = y.reduce((a, b) => a + b, 0) / n;

        let sumXY = 0, sumX2 = 0, ssRes = 0, ssTot = 0;
        for (let i = 0; i < n; i++) {
          sumXY += (x[i]! - meanX) * (y[i]! - meanY);
          sumX2 += (x[i]! - meanX) ** 2;
        }

        const slope = sumX2 > 0 ? sumXY / sumX2 : 0;
        const intercept = meanY - slope * meanX;

        for (let i = 0; i < n; i++) {
          const predicted = slope * x[i]! + intercept;
          ssRes += (y[i]! - predicted) ** 2;
          ssTot += (y[i]! - meanY) ** 2;
        }

        const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;

        const result: Record<string, unknown> = {
          equation: `y = ${round(slope)}x + ${round(intercept)}`,
          slope: round(slope),
          intercept: round(intercept),
          rSquared: round(rSquared),
          n,
        };

        if (params.predictX?.length) {
          result.predictions = params.predictX.map((xVal) => ({
            x: xVal,
            predictedY: round(slope * xVal + intercept),
          }));
        }

        return result;
      },
    });

    ctx.registerTool({
      name: "stats_percentiles",
      description: "Calculate specific percentiles for a dataset.",
      parameters: PercentilesParams,

      async execute(params) {
        const sorted = [...params.values].sort((a, b) => a - b);
        const results = params.percentiles.map((p) => ({
          percentile: p,
          value: round(percentile(sorted, p)),
        }));

        return { count: params.values.length, percentiles: results };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "statistics",
      instructions: "You can perform statistical analysis with `stats_descriptive` (mean/median/std dev/etc.), `stats_correlation` (Pearson r), `stats_regression` (linear regression with predictions), and `stats_percentiles`.",
    };
  },
};

export default statisticsSkill;
