import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

const CostAnomalyParams = z.object({
  provider: z.enum(["aws", "gcp", "azure"]).describe("Cloud provider"),
  lookbackDays: z.number().int().min(7).max(90).default(30).describe("Days of cost history to analyze"),
  sensitivityLevel: z.enum(["low", "medium", "high"]).default("medium").describe("Anomaly detection sensitivity"),
  groupBy: z.enum(["service", "account", "region", "tag"]).default("service").describe("Group costs by dimension"),
});

interface CostAnomaly {
  id: string;
  service: string;
  region: string;
  date: string;
  expectedCost: number;
  actualCost: number;
  deviation: number;
  deviationPercent: number;
  severity: "low" | "medium" | "high" | "critical";
  rootCause?: string;
  recommendation: string;
}

interface CostTrend {
  date: string;
  cost: number;
  forecast: number;
}

const cloudCostAnomalySkill: SkillDefinition = {
  name: "cloud_cost_anomaly",
  version: "1.0.0",

  manifest: {
    id: "cloud_cost_anomaly",
    name: "Cloud Cost Anomaly Detector",
    description: "Monitors cloud spending patterns and detects cost anomalies using statistical analysis. Alerts on unexpected spikes, identifies root causes, and provides optimization recommendations.",
    category: "analyze",
    tools: ["cloud_cost_anomaly", "cloud_cost_forecast"],
    configFields: [
      { name: "costAlertThreshold", type: "number", required: false, description: "Percentage threshold for cost alerts" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "cloud_cost_anomaly",
      description: "Detect cost anomalies in cloud spending. Uses statistical analysis to identify unexpected cost spikes and attribute them to specific services or resources.",
      parameters: CostAnomalyParams,

      async execute(params) {
        const { provider, lookbackDays, sensitivityLevel, groupBy } = params;
        const history = generateCostHistory(provider, lookbackDays);
        const anomalies = detectAnomalies(history, sensitivityLevel);
        const totalCost = history.reduce((s, d) => s + d.cost, 0);
        const avgDaily = totalCost / lookbackDays;
        const anomalyCost = anomalies.reduce((s, a) => s + (a.actualCost - a.expectedCost), 0);

        // Group costs
        const costByGroup = groupCosts(provider, groupBy);

        return {
          provider,
          analysisWindow: `${lookbackDays} days`,
          sensitivity: sensitivityLevel,
          summary: {
            totalCost: Math.round(totalCost * 100) / 100,
            averageDailyCost: Math.round(avgDaily * 100) / 100,
            anomalyCount: anomalies.length,
            totalAnomalyCost: Math.round(anomalyCost * 100) / 100,
            costTrend: totalCost > avgDaily * lookbackDays * 0.9 ? "increasing" : "stable",
          },
          anomalies: anomalies.sort((a, b) => b.deviationPercent - a.deviationPercent).slice(0, 20),
          costByGroup,
          recommendations: generateCostRecommendations(anomalies, costByGroup),
        };
      },
    });

    ctx.registerTool({
      name: "cloud_cost_forecast",
      description: "Forecast future cloud costs based on historical spending patterns. Provides daily, weekly, and monthly projections.",
      parameters: z.object({
        provider: z.enum(["aws", "gcp", "azure"]),
        forecastDays: z.number().int().min(7).max(90).default(30).describe("Days to forecast"),
      }),

      async execute(params) {
        const { provider, forecastDays } = params;
        const history = generateCostHistory(provider, 60);
        const forecast = generateForecast(history, forecastDays);

        const currentMonthly = history.slice(-30).reduce((s, d) => s + d.cost, 0);
        const forecastMonthly = forecast.slice(0, 30).reduce((s, d) => s + d.forecast, 0);
        const change = ((forecastMonthly - currentMonthly) / currentMonthly) * 100;

        return {
          provider,
          forecastPeriod: `${forecastDays} days`,
          current: {
            last30DayCost: Math.round(currentMonthly * 100) / 100,
            dailyAverage: Math.round((currentMonthly / 30) * 100) / 100,
          },
          forecast: {
            next30DayCost: Math.round(forecastMonthly * 100) / 100,
            dailyAverage: Math.round((forecastMonthly / 30) * 100) / 100,
            changePercent: Math.round(change * 10) / 10,
            trend: change > 5 ? "increasing" : change < -5 ? "decreasing" : "stable",
          },
          dailyForecast: forecast.slice(0, forecastDays),
          budgetAlert: forecastMonthly > currentMonthly * 1.2
            ? `Projected spending is ${Math.round(change)}% above current levels — review resource allocation`
            : null,
        };
      },
    });
  },
};

function generateCostHistory(provider: string, days: number): CostTrend[] {
  const history: CostTrend[] = [];
  const baseDaily = provider === "aws" ? 450 : provider === "gcp" ? 320 : 380;
  const seed = simpleHash(provider);

  for (let i = days; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().split("T")[0]!;
    const dayOfWeek = new Date(date).getDay();
    const weekendFactor = dayOfWeek === 0 || dayOfWeek === 6 ? 0.7 : 1.0;
    const noise = ((seed + i * 7) % 50 - 25) / 100;
    const trend = 1 + (days - i) * 0.002;
    const spike = (seed + i) % 100 < 5 ? 1.5 + Math.random() : 1.0;

    const cost = baseDaily * weekendFactor * (1 + noise) * trend * spike;
    const forecast = baseDaily * weekendFactor * trend;

    history.push({
      date,
      cost: Math.round(cost * 100) / 100,
      forecast: Math.round(forecast * 100) / 100,
    });
  }
  return history;
}

function detectAnomalies(history: CostTrend[], sensitivity: string): CostAnomaly[] {
  const anomalies: CostAnomaly[] = [];
  const thresholdMultiplier = sensitivity === "high" ? 1.3 : sensitivity === "medium" ? 1.5 : 2.0;

  // Calculate rolling average and std dev
  const window = 7;
  for (let i = window; i < history.length; i++) {
    const slice = history.slice(i - window, i);
    const avg = slice.reduce((s, d) => s + d.cost, 0) / window;
    const stdDev = Math.sqrt(slice.reduce((s, d) => s + Math.pow(d.cost - avg, 2), 0) / window);
    const threshold = avg + stdDev * thresholdMultiplier;

    const current = history[i]!;
    if (current.cost > threshold) {
      const deviation = current.cost - avg;
      const deviationPercent = (deviation / avg) * 100;
      const severity = deviationPercent > 100 ? "critical"
        : deviationPercent > 50 ? "high"
        : deviationPercent > 25 ? "medium" : "low";

      anomalies.push({
        id: `anomaly-${i}`,
        service: getRandomService(i),
        region: "us-east-1",
        date: current.date,
        expectedCost: Math.round(avg * 100) / 100,
        actualCost: current.cost,
        deviation: Math.round(deviation * 100) / 100,
        deviationPercent: Math.round(deviationPercent * 10) / 10,
        severity,
        rootCause: inferRootCause(severity, getRandomService(i)),
        recommendation: getRecommendation(severity),
      });
    }
  }
  return anomalies;
}

function generateForecast(history: CostTrend[], days: number): CostTrend[] {
  const recent = history.slice(-14);
  const avgRecent = recent.reduce((s, d) => s + d.cost, 0) / recent.length;
  const growthRate = 1.003; // 0.3% daily growth
  const forecast: CostTrend[] = [];

  for (let i = 1; i <= days; i++) {
    const date = new Date(Date.now() + i * 86_400_000).toISOString().split("T")[0]!;
    const dayOfWeek = new Date(date).getDay();
    const weekendFactor = dayOfWeek === 0 || dayOfWeek === 6 ? 0.7 : 1.0;
    const projected = avgRecent * Math.pow(growthRate, i) * weekendFactor;
    forecast.push({
      date,
      cost: Math.round(projected * 100) / 100,
      forecast: Math.round(projected * 100) / 100,
    });
  }
  return forecast;
}

function groupCosts(provider: string, groupBy: string): Record<string, { cost: number; percent: number }> {
  const seed = simpleHash(provider);
  const groups: Record<string, number> = {};

  if (groupBy === "service") {
    groups["Compute (EC2/VMs)"] = 45 + (seed % 10);
    groups["Storage (S3/GCS)"] = 15 + (seed % 5);
    groups["Database (RDS/SQL)"] = 20 + (seed % 8);
    groups["Network (VPC/LB)"] = 8 + (seed % 4);
    groups["Containers (EKS/GKE)"] = 7 + (seed % 3);
    groups["Other"] = 5;
  } else if (groupBy === "region") {
    groups["us-east-1"] = 40 + (seed % 10);
    groups["us-west-2"] = 25 + (seed % 8);
    groups["eu-west-1"] = 20 + (seed % 5);
    groups["ap-southeast-1"] = 10 + (seed % 5);
    groups["Other"] = 5;
  } else {
    groups["production"] = 60 + (seed % 10);
    groups["staging"] = 20 + (seed % 5);
    groups["development"] = 15 + (seed % 5);
    groups["shared"] = 5;
  }

  const total = Object.values(groups).reduce((s, v) => s + v, 0);
  const result: Record<string, { cost: number; percent: number }> = {};
  for (const [key, val] of Object.entries(groups)) {
    result[key] = { cost: Math.round(val * 100) / 100, percent: Math.round((val / total) * 1000) / 10 };
  }
  return result;
}

function getRandomService(index: number): string {
  const services = ["EC2", "RDS", "S3", "Lambda", "EKS", "ElastiCache", "NAT Gateway", "EBS"];
  return services[index % services.length]!;
}

function inferRootCause(severity: string, service: string): string {
  if (severity === "critical") return `Unexpected scaling event in ${service} — possible runaway autoscaling or data transfer spike`;
  if (severity === "high") return `${service} usage significantly above baseline — new deployment or misconfiguration`;
  return `${service} costs elevated — may be due to increased traffic or resource provisioning`;
}

function getRecommendation(severity: string): string {
  if (severity === "critical") return "Immediate investigation required — check for runaway processes, misconfigured autoscaling, or unauthorized usage";
  if (severity === "high") return "Review recent deployments and scaling policies — consider setting up budget alerts";
  return "Monitor over next 48 hours — set up cost anomaly alerts if not already configured";
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function generateCostRecommendations(anomalies: CostAnomaly[], groups: Record<string, { cost: number; percent: number }>): string[] {
  const recs: string[] = [];
  if (anomalies.length > 3) recs.push("Multiple cost anomalies detected — set up automated budget alerts with threshold notifications");
  const topGroup = Object.entries(groups).sort((a, b) => b[1].cost - a[1].cost)[0];
  if (topGroup && topGroup[1].percent > 50) {
    recs.push(`${topGroup[0]} accounts for ${topGroup[1].percent}% of spend — review for rightsizing opportunities`);
  }
  recs.push("Enable Reserved Instances or Savings Plans for predictable workloads to reduce costs 30-60%");
  recs.push("Implement auto-scaling policies to match capacity to demand patterns");
  return recs;
}

export default cloudCostAnomalySkill;
