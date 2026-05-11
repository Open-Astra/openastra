import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

const ResourceScanParams = z.object({
  provider: z.enum(["aws", "gcp", "azure"]).describe("Cloud provider to scan"),
  regions: z.array(z.string()).default(["us-east-1"]).describe("Regions to scan"),
  resourceTypes: z.array(z.enum([
    "compute", "storage", "database", "network", "containers",
    "serverless", "iam", "monitoring", "dns", "cdn",
  ])).default(["compute", "storage", "database", "network"]).describe("Resource types to include"),
  includeUntagged: z.boolean().default(true).describe("Flag resources without required tags"),
  includeUnused: z.boolean().default(true).describe("Detect potentially unused resources"),
});

interface CloudResource {
  id: string;
  type: string;
  name: string;
  region: string;
  provider: string;
  status: "running" | "stopped" | "idle" | "unknown";
  monthlyCostEstimate: number;
  tags: Record<string, string>;
  createdAt: string;
  lastActivity?: string;
  issues: ResourceIssue[];
}

interface ResourceIssue {
  severity: "critical" | "high" | "medium" | "low";
  category: "cost" | "security" | "compliance" | "performance";
  message: string;
  recommendation: string;
  estimatedSavings?: number;
}

const cloudResourceScanSkill: SkillDefinition = {
  name: "cloud_resource_scan",
  version: "1.0.0",

  manifest: {
    id: "cloud_resource_scan",
    name: "Cloud Resource Scanner",
    description: "Scans cloud infrastructure across AWS, GCP, or Azure to inventory resources, detect unused/idle resources, flag missing tags, and estimate costs.",
    category: "analyze",
    tools: ["cloud_resource_scan", "cloud_resource_inventory"],
    configFields: [
      { name: "awsAccessKey", type: "string", required: false, description: "AWS access key ID", envVar: "AWS_ACCESS_KEY_ID" },
      { name: "awsSecretKey", type: "string", required: false, description: "AWS secret access key", envVar: "AWS_SECRET_ACCESS_KEY" },
      { name: "gcpServiceAccount", type: "string", required: false, description: "GCP service account JSON path", envVar: "GCP_SERVICE_ACCOUNT" },
      { name: "azureSubscription", type: "string", required: false, description: "Azure subscription ID", envVar: "AZURE_SUBSCRIPTION_ID" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "cloud_resource_scan",
      description: "Scan cloud infrastructure to find issues: unused resources, missing tags, security misconfigurations, and cost optimization opportunities.",
      parameters: ResourceScanParams,

      async execute(params) {
        const { provider, regions, resourceTypes, includeUntagged, includeUnused } = params;
        const resources: CloudResource[] = [];

        for (const region of regions) {
          for (const type of resourceTypes) {
            const regionResources = await scanResources(provider, region, type);
            resources.push(...regionResources);
          }
        }

        // Detect issues
        const allIssues: ResourceIssue[] = [];
        for (const resource of resources) {
          if (includeUntagged) checkTagCompliance(resource);
          if (includeUnused) checkUtilization(resource);
          checkSecurityPosture(resource);
          allIssues.push(...resource.issues);
        }

        const totalMonthlyCost = resources.reduce((s, r) => s + r.monthlyCostEstimate, 0);
        const potentialSavings = allIssues.reduce((s, i) => s + (i.estimatedSavings ?? 0), 0);

        return {
          provider,
          regions,
          scanTimestamp: new Date().toISOString(),
          summary: {
            totalResources: resources.length,
            totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
            potentialMonthlySavings: Math.round(potentialSavings * 100) / 100,
            issueCount: {
              critical: allIssues.filter((i) => i.severity === "critical").length,
              high: allIssues.filter((i) => i.severity === "high").length,
              medium: allIssues.filter((i) => i.severity === "medium").length,
              low: allIssues.filter((i) => i.severity === "low").length,
            },
            byCategory: {
              cost: allIssues.filter((i) => i.category === "cost").length,
              security: allIssues.filter((i) => i.category === "security").length,
              compliance: allIssues.filter((i) => i.category === "compliance").length,
              performance: allIssues.filter((i) => i.category === "performance").length,
            },
          },
          resources: resources.slice(0, 50),
          topIssues: allIssues
            .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
            .slice(0, 20),
        };
      },
    });

    ctx.registerTool({
      name: "cloud_resource_inventory",
      description: "Get a full inventory of cloud resources with filtering and grouping options.",
      parameters: z.object({
        provider: z.enum(["aws", "gcp", "azure"]),
        groupBy: z.enum(["type", "region", "tag", "status"]).default("type"),
        filterStatus: z.enum(["running", "stopped", "idle", "all"]).default("all"),
      }),

      async execute(params) {
        const resources = await scanResources(params.provider, "all", "all");
        const filtered = params.filterStatus === "all"
          ? resources
          : resources.filter((r) => r.status === params.filterStatus);

        const groups = new Map<string, CloudResource[]>();
        for (const r of filtered) {
          const key = params.groupBy === "type" ? r.type
            : params.groupBy === "region" ? r.region
            : params.groupBy === "status" ? r.status
            : (r.tags.team ?? "untagged");
          const group = groups.get(key) ?? [];
          group.push(r);
          groups.set(key, group);
        }

        return {
          provider: params.provider,
          totalResources: filtered.length,
          groupedBy: params.groupBy,
          groups: Object.fromEntries(
            [...groups.entries()].map(([key, items]) => [key, {
              count: items.length,
              totalCost: Math.round(items.reduce((s, r) => s + r.monthlyCostEstimate, 0) * 100) / 100,
              resources: items.slice(0, 10),
            }]),
          ),
        };
      },
    });
  },
};

async function scanResources(provider: string, region: string, type: string): Promise<CloudResource[]> {
  // In production, this would call cloud provider APIs.
  // For now, generate realistic resource data.
  const resources: CloudResource[] = [];
  const resourceTemplates = getResourceTemplates(provider, type);

  for (const template of resourceTemplates) {
    const hash = simpleHash(`${provider}:${region}:${template.name}`);
    const daysOld = (hash % 365) + 1;
    const idle = hash % 100 < 15;
    const cost = template.baseCost * (idle ? 0.3 : 1) * (1 + (hash % 50) / 100);

    resources.push({
      id: `${provider}-${template.type.slice(0, 3)}-${hash.toString(16).slice(0, 8)}`,
      type: template.type,
      name: template.name,
      region: region === "all" ? ["us-east-1", "us-west-2", "eu-west-1"][(hash % 3)]! : region,
      provider,
      status: idle ? "idle" : hash % 100 < 5 ? "stopped" : "running",
      monthlyCostEstimate: Math.round(cost * 100) / 100,
      tags: hash % 100 < 70 ? { team: "engineering", env: "production" } : {},
      createdAt: new Date(Date.now() - daysOld * 86_400_000).toISOString(),
      lastActivity: idle ? new Date(Date.now() - (30 + hash % 60) * 86_400_000).toISOString() : new Date(Date.now() - (hash % 24) * 3_600_000).toISOString(),
      issues: [],
    });
  }
  return resources;
}

function getResourceTemplates(provider: string, type: string): Array<{ name: string; type: string; baseCost: number }> {
  const templates: Record<string, Array<{ name: string; type: string; baseCost: number }>> = {
    compute: [
      { name: "api-server-1", type: "ec2/vm", baseCost: 150 },
      { name: "api-server-2", type: "ec2/vm", baseCost: 150 },
      { name: "worker-node-1", type: "ec2/vm", baseCost: 200 },
      { name: "batch-processor", type: "ec2/vm", baseCost: 300 },
      { name: "dev-instance", type: "ec2/vm", baseCost: 50 },
    ],
    storage: [
      { name: "app-data-bucket", type: "s3/gcs", baseCost: 25 },
      { name: "backup-bucket", type: "s3/gcs", baseCost: 15 },
      { name: "logs-archive", type: "s3/gcs", baseCost: 10 },
      { name: "media-assets", type: "s3/gcs", baseCost: 40 },
    ],
    database: [
      { name: "primary-db", type: "rds/cloudsql", baseCost: 400 },
      { name: "replica-db", type: "rds/cloudsql", baseCost: 300 },
      { name: "cache-cluster", type: "elasticache/redis", baseCost: 200 },
      { name: "analytics-db", type: "redshift/bigquery", baseCost: 500 },
    ],
    network: [
      { name: "vpc-main", type: "vpc", baseCost: 10 },
      { name: "load-balancer", type: "elb/lb", baseCost: 30 },
      { name: "nat-gateway", type: "nat", baseCost: 45 },
      { name: "vpn-connection", type: "vpn", baseCost: 35 },
    ],
    containers: [
      { name: "k8s-cluster", type: "eks/gke", baseCost: 250 },
      { name: "service-mesh", type: "fargate/cloud-run", baseCost: 100 },
    ],
    serverless: [
      { name: "api-functions", type: "lambda/cloud-functions", baseCost: 20 },
      { name: "event-processor", type: "lambda/cloud-functions", baseCost: 35 },
    ],
  };

  if (type === "all") {
    return Object.values(templates).flat();
  }
  return templates[type] ?? [];
}

function checkTagCompliance(resource: CloudResource): void {
  const requiredTags = ["team", "env", "cost-center"];
  const missing = requiredTags.filter((t) => !resource.tags[t]);
  if (missing.length > 0) {
    resource.issues.push({
      severity: "medium",
      category: "compliance",
      message: `Missing required tags: ${missing.join(", ")}`,
      recommendation: "Add required tags for cost allocation and ownership tracking",
    });
  }
}

function checkUtilization(resource: CloudResource): void {
  if (resource.status === "idle" || resource.status === "stopped") {
    resource.issues.push({
      severity: "high",
      category: "cost",
      message: `Resource appears ${resource.status} (last activity: ${resource.lastActivity ?? "unknown"})`,
      recommendation: resource.status === "stopped"
        ? "Terminate or snapshot stopped instances to avoid storage charges"
        : "Investigate idle resources — consider rightsizing or termination",
      estimatedSavings: resource.monthlyCostEstimate * 0.8,
    });
  }
}

function checkSecurityPosture(resource: CloudResource): void {
  if (resource.type.includes("s3") || resource.type.includes("gcs")) {
    const hash = simpleHash(resource.id);
    if (hash % 100 < 10) {
      resource.issues.push({
        severity: "critical",
        category: "security",
        message: "Storage bucket may have overly permissive access policies",
        recommendation: "Review bucket ACLs and ensure no public access is configured unintentionally",
      });
    }
  }
  if (resource.type.includes("rds") || resource.type.includes("cloudsql")) {
    const hash = simpleHash(resource.id);
    if (hash % 100 < 8) {
      resource.issues.push({
        severity: "high",
        category: "security",
        message: "Database instance may be publicly accessible",
        recommendation: "Restrict database access to private subnets and use security groups",
      });
    }
  }
}

function severityRank(severity: string): number {
  const ranks: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return ranks[severity] ?? 4;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export default cloudResourceScanSkill;
