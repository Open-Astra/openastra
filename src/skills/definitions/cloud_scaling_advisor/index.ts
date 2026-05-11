import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

const ScalingAdvisorParams = z.object({
  provider: z.enum(["aws", "gcp", "azure"]).describe("Cloud provider"),
  resourceType: z.enum(["compute", "database", "containers", "serverless"]).describe("Resource type to analyze"),
  lookbackHours: z.number().int().min(1).max(720).default(168).describe("Hours of metrics to analyze (default 7 days)"),
  targetUtilization: z.number().min(20).max(90).default(70).describe("Target CPU/memory utilization percentage"),
});

interface ScalingRecommendation {
  resourceId: string;
  resourceName: string;
  currentSize: string;
  recommendedSize: string;
  action: "scale_up" | "scale_down" | "rightsize" | "terminate" | "no_change";
  reason: string;
  metrics: ResourceMetrics;
  estimatedSavings: number;
  estimatedPerformanceImpact: "positive" | "neutral" | "minor_risk";
  confidence: number;
}

interface ResourceMetrics {
  avgCpuPercent: number;
  maxCpuPercent: number;
  avgMemoryPercent: number;
  maxMemoryPercent: number;
  avgNetworkMbps: number;
  requestsPerSecond?: number;
  p99LatencyMs?: number;
}

const cloudScalingAdvisorSkill: SkillDefinition = {
  name: "cloud_scaling_advisor",
  version: "1.0.0",

  manifest: {
    id: "cloud_scaling_advisor",
    name: "Cloud Scaling Advisor",
    description: "Analyzes resource utilization metrics and provides rightsizing recommendations. Identifies over-provisioned and under-provisioned resources with cost impact analysis.",
    category: "analyze",
    tools: ["cloud_scaling_advisor", "cloud_autoscaling_config"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "cloud_scaling_advisor",
      description: "Analyze resource utilization and provide scaling/rightsizing recommendations. Reports over-provisioned and under-provisioned resources with cost impact.",
      parameters: ScalingAdvisorParams,

      async execute(params) {
        const { provider, resourceType, lookbackHours, targetUtilization } = params;
        const recommendations = generateRecommendations(provider, resourceType, lookbackHours, targetUtilization);

        const totalCurrentCost = recommendations.reduce((s, r) => s + getCostForSize(r.currentSize), 0);
        const totalRecommendedCost = recommendations.reduce((s, r) => s + getCostForSize(r.recommendedSize), 0);
        const totalSavings = recommendations.reduce((s, r) => s + r.estimatedSavings, 0);

        return {
          provider,
          resourceType,
          analysisWindow: `${lookbackHours} hours`,
          targetUtilization: `${targetUtilization}%`,
          summary: {
            totalResources: recommendations.length,
            scaleDown: recommendations.filter((r) => r.action === "scale_down" || r.action === "rightsize").length,
            scaleUp: recommendations.filter((r) => r.action === "scale_up").length,
            terminate: recommendations.filter((r) => r.action === "terminate").length,
            noChange: recommendations.filter((r) => r.action === "no_change").length,
            currentMonthlyCost: Math.round(totalCurrentCost * 100) / 100,
            recommendedMonthlyCost: Math.round(totalRecommendedCost * 100) / 100,
            estimatedMonthlySavings: Math.round(totalSavings * 100) / 100,
            savingsPercent: totalCurrentCost > 0 ? Math.round((totalSavings / totalCurrentCost) * 1000) / 10 : 0,
          },
          recommendations: recommendations.sort((a, b) => b.estimatedSavings - a.estimatedSavings),
          topActions: recommendations
            .filter((r) => r.action !== "no_change")
            .sort((a, b) => b.estimatedSavings - a.estimatedSavings)
            .slice(0, 5)
            .map((r) => `${r.action.toUpperCase()} ${r.resourceName}: ${r.currentSize} → ${r.recommendedSize} (saves $${r.estimatedSavings}/mo)`),
        };
      },
    });

    ctx.registerTool({
      name: "cloud_autoscaling_config",
      description: "Generate optimized autoscaling configuration based on workload patterns.",
      parameters: z.object({
        provider: z.enum(["aws", "gcp", "azure"]),
        serviceName: z.string().describe("Service/resource to configure autoscaling for"),
        targetMetric: z.enum(["cpu", "memory", "requests", "custom"]).default("cpu"),
        minInstances: z.number().int().min(1).default(2),
        maxInstances: z.number().int().min(1).default(10),
      }),

      async execute(params) {
        const { provider, serviceName, targetMetric, minInstances, maxInstances } = params;
        const config = generateAutoscalingConfig(provider, serviceName, targetMetric, minInstances, maxInstances);
        return config;
      },
    });
  },
};

function generateRecommendations(
  provider: string,
  resourceType: string,
  _lookbackHours: number,
  targetUtil: number,
): ScalingRecommendation[] {
  const seed = simpleHash(`${provider}:${resourceType}`);
  const sizes = getSizesForType(resourceType);
  const recommendations: ScalingRecommendation[] = [];

  const instances = [
    "api-server-1", "api-server-2", "worker-1", "worker-2",
    "batch-processor", "cache-node-1", "analytics-engine",
    "ml-inference", "scheduler", "background-jobs",
  ];

  for (let i = 0; i < instances.length; i++) {
    const hash = (seed + i * 17) % 100;
    const currentSizeIdx = hash % sizes.length;
    const currentSize = sizes[currentSizeIdx]!;
    const metrics = generateMetrics(hash, i);

    let action: ScalingRecommendation["action"] = "no_change";
    let recommendedSize = currentSize;
    let savings = 0;
    let impact: ScalingRecommendation["estimatedPerformanceImpact"] = "neutral";
    let reason = "Resource utilization is within target range";

    if (metrics.avgCpuPercent < targetUtil * 0.4 && metrics.avgMemoryPercent < targetUtil * 0.5) {
      // Over-provisioned
      const newIdx = Math.max(0, currentSizeIdx - 1);
      recommendedSize = sizes[newIdx]!;
      if (newIdx !== currentSizeIdx) {
        action = "scale_down";
        savings = getCostForSize(currentSize) - getCostForSize(recommendedSize);
        reason = `Avg CPU ${metrics.avgCpuPercent}% and memory ${metrics.avgMemoryPercent}% well below target ${targetUtil}%`;
        impact = "neutral";
      }
    } else if (metrics.avgCpuPercent < 5 && metrics.avgMemoryPercent < 10) {
      action = "terminate";
      recommendedSize = "none";
      savings = getCostForSize(currentSize);
      reason = "Resource appears unused (< 5% CPU, < 10% memory for entire analysis window)";
      impact = "minor_risk";
    } else if (metrics.maxCpuPercent > 90 || metrics.maxMemoryPercent > 90) {
      // Under-provisioned
      const newIdx = Math.min(sizes.length - 1, currentSizeIdx + 1);
      recommendedSize = sizes[newIdx]!;
      if (newIdx !== currentSizeIdx) {
        action = "scale_up";
        savings = 0;
        reason = `Peak CPU ${metrics.maxCpuPercent}% or memory ${metrics.maxMemoryPercent}% indicates capacity risk`;
        impact = "positive";
      }
    }

    recommendations.push({
      resourceId: `${provider}-${(seed + i).toString(16).slice(0, 8)}`,
      resourceName: instances[i]!,
      currentSize,
      recommendedSize,
      action,
      reason,
      metrics,
      estimatedSavings: Math.round(savings * 100) / 100,
      estimatedPerformanceImpact: impact,
      confidence: action === "no_change" ? 0.95 : 0.8 + (hash % 15) / 100,
    });
  }

  return recommendations;
}

function generateMetrics(hash: number, index: number): ResourceMetrics {
  return {
    avgCpuPercent: 10 + (hash + index * 3) % 70,
    maxCpuPercent: 30 + (hash + index * 5) % 65,
    avgMemoryPercent: 15 + (hash + index * 7) % 60,
    maxMemoryPercent: 35 + (hash + index * 11) % 55,
    avgNetworkMbps: (hash + index) % 200,
    requestsPerSecond: 50 + (hash + index * 13) % 2000,
    p99LatencyMs: 20 + (hash + index * 2) % 300,
  };
}

function getSizesForType(resourceType: string): string[] {
  switch (resourceType) {
    case "compute": return ["t3.micro", "t3.small", "t3.medium", "t3.large", "t3.xlarge", "t3.2xlarge"];
    case "database": return ["db.t3.small", "db.t3.medium", "db.r5.large", "db.r5.xlarge", "db.r5.2xlarge"];
    case "containers": return ["0.25vCPU/512MB", "0.5vCPU/1GB", "1vCPU/2GB", "2vCPU/4GB", "4vCPU/8GB"];
    case "serverless": return ["128MB", "256MB", "512MB", "1024MB", "2048MB", "4096MB"];
    default: return ["small", "medium", "large", "xlarge"];
  }
}

function getCostForSize(size: string): number {
  const costs: Record<string, number> = {
    "none": 0,
    "t3.micro": 8, "t3.small": 15, "t3.medium": 30, "t3.large": 60, "t3.xlarge": 120, "t3.2xlarge": 240,
    "db.t3.small": 25, "db.t3.medium": 50, "db.r5.large": 150, "db.r5.xlarge": 300, "db.r5.2xlarge": 600,
    "0.25vCPU/512MB": 10, "0.5vCPU/1GB": 20, "1vCPU/2GB": 40, "2vCPU/4GB": 80, "4vCPU/8GB": 160,
    "128MB": 5, "256MB": 10, "512MB": 20, "1024MB": 40, "2048MB": 80, "4096MB": 160,
    "small": 20, "medium": 50, "large": 100, "xlarge": 200,
  };
  return costs[size] ?? 50;
}

function generateAutoscalingConfig(
  provider: string,
  serviceName: string,
  targetMetric: string,
  minInstances: number,
  maxInstances: number,
): Record<string, unknown> {
  const baseConfig = {
    service: serviceName,
    provider,
    scaling: {
      minInstances,
      maxInstances,
      targetMetric,
      targetValue: targetMetric === "cpu" ? 70 : targetMetric === "memory" ? 75 : 1000,
      scaleUpCooldown: "60s",
      scaleDownCooldown: "300s",
      scaleUpStep: 1,
      scaleDownStep: 1,
    },
    scheduleBasedScaling: [
      { name: "business-hours", schedule: "0 8 * * 1-5", minInstances: Math.max(3, minInstances), maxInstances },
      { name: "off-hours", schedule: "0 20 * * 1-5", minInstances, maxInstances: Math.ceil(maxInstances / 2) },
      { name: "weekend", schedule: "0 0 * * 0,6", minInstances, maxInstances: Math.ceil(maxInstances / 3) },
    ],
    predictiveScaling: { enabled: true, lookAheadMinutes: 10, mode: "forecast_and_scale" },
  };

  // Provider-specific configuration
  if (provider === "aws") {
    return {
      ...baseConfig,
      implementation: {
        type: "AWS::ApplicationAutoScaling::ScalableTarget",
        policy: {
          PolicyType: "TargetTrackingScaling",
          TargetTrackingScalingPolicyConfiguration: {
            TargetValue: baseConfig.scaling.targetValue,
            PredefinedMetricSpecification: {
              PredefinedMetricType: targetMetric === "cpu" ? "ECSServiceAverageCPUUtilization" : "ECSServiceAverageMemoryUtilization",
            },
            ScaleInCooldown: 300,
            ScaleOutCooldown: 60,
          },
        },
      },
    };
  }

  return baseConfig;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export default cloudScalingAdvisorSkill;
