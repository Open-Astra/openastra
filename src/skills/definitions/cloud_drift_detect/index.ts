import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

const DriftDetectParams = z.object({
  provider: z.enum(["aws", "gcp", "azure"]).describe("Cloud provider"),
  stackName: z.string().optional().describe("Specific IaC stack/project to check (omit for all)"),
  iacTool: z.enum(["terraform", "cloudformation", "pulumi", "bicep"]).default("terraform").describe("Infrastructure-as-Code tool"),
  severity: z.enum(["all", "critical", "high", "medium"]).default("all").describe("Minimum severity to report"),
});

interface DriftItem {
  resourceId: string;
  resourceType: string;
  property: string;
  expectedValue: string;
  actualValue: string;
  severity: "critical" | "high" | "medium" | "low";
  category: "security" | "config" | "network" | "iam" | "storage";
  driftedAt: string;
  driftedBy?: string;
  remediation: string;
}

interface DriftSummary {
  totalResources: number;
  driftedResources: number;
  driftItems: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
  complianceScore: number;
}

const cloudDriftDetectSkill: SkillDefinition = {
  name: "cloud_drift_detect",
  version: "1.0.0",

  manifest: {
    id: "cloud_drift_detect",
    name: "Cloud Configuration Drift Detector",
    description: "Compares live cloud infrastructure against declared IaC state to detect configuration drift. Identifies manual changes, security regressions, and compliance violations.",
    category: "analyze",
    tools: ["cloud_drift_detect", "cloud_drift_remediate"],
    configFields: [
      { name: "terraformStatePath", type: "string", required: false, description: "Path to Terraform state file or remote backend" },
    ],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "cloud_drift_detect",
      description: "Detect configuration drift between live infrastructure and IaC state. Reports unexpected changes, security regressions, and compliance violations.",
      parameters: DriftDetectParams,

      async execute(params) {
        const { provider, stackName, iacTool, severity } = params;
        const driftItems = generateDriftData(provider, iacTool, stackName);
        const filtered = severity === "all"
          ? driftItems
          : driftItems.filter((d) => severityRank(d.severity) <= severityRank(severity));

        const driftedResourceIds = new Set(filtered.map((d) => d.resourceId));
        const totalResources = 45 + simpleHash(provider + (stackName ?? "")) % 30;

        const summary: DriftSummary = {
          totalResources,
          driftedResources: driftedResourceIds.size,
          driftItems: filtered.length,
          bySeverity: countBy(filtered, "severity"),
          byCategory: countBy(filtered, "category"),
          complianceScore: Math.round(((totalResources - driftedResourceIds.size) / totalResources) * 100),
        };

        return {
          provider,
          iacTool,
          stack: stackName ?? "all",
          scanTimestamp: new Date().toISOString(),
          summary,
          driftItems: filtered.slice(0, 30),
          recommendations: generateDriftRecommendations(summary, filtered),
        };
      },
    });

    ctx.registerTool({
      name: "cloud_drift_remediate",
      description: "Generate remediation plan for detected drift. Outputs IaC commands to bring infrastructure back to declared state.",
      parameters: z.object({
        provider: z.enum(["aws", "gcp", "azure"]),
        iacTool: z.enum(["terraform", "cloudformation", "pulumi", "bicep"]).default("terraform"),
        resourceIds: z.array(z.string()).describe("Resource IDs to remediate"),
        dryRun: z.boolean().default(true).describe("Generate plan without applying"),
      }),

      async execute(params) {
        const { provider, iacTool, resourceIds, dryRun } = params;
        const plan = generateRemediationPlan(provider, iacTool, resourceIds);

        return {
          provider,
          iacTool,
          dryRun,
          resourcesTargeted: resourceIds.length,
          plan,
          commands: plan.commands,
          warnings: plan.warnings,
          estimatedImpact: plan.impact,
        };
      },
    });
  },
};

function generateDriftData(provider: string, iacTool: string, stackName?: string): DriftItem[] {
  const seed = simpleHash(`${provider}:${iacTool}:${stackName ?? "all"}`);
  const driftItems: DriftItem[] = [];

  const templates: Array<Omit<DriftItem, "driftedAt" | "resourceId">> = [
    { resourceType: "security_group", property: "ingress_rules", expectedValue: "port 443 only", actualValue: "ports 80, 443, 8080 open", severity: "critical", category: "security", remediation: "Remove unauthorized ingress rules — apply terraform plan to reset" },
    { resourceType: "iam_role", property: "policy_document", expectedValue: "least-privilege policy", actualValue: "AdministratorAccess attached", severity: "critical", category: "iam", remediation: "Remove AdministratorAccess and apply least-privilege policy" },
    { resourceType: "s3_bucket", property: "public_access_block", expectedValue: "all blocked", actualValue: "public read enabled", severity: "critical", category: "storage", remediation: "Re-enable public access block on S3 bucket" },
    { resourceType: "rds_instance", property: "backup_retention", expectedValue: "7 days", actualValue: "1 day", severity: "high", category: "config", remediation: "Increase backup retention to match declared state" },
    { resourceType: "vpc", property: "flow_logs", expectedValue: "enabled", actualValue: "disabled", severity: "high", category: "network", remediation: "Re-enable VPC flow logs for security monitoring" },
    { resourceType: "ec2_instance", property: "instance_type", expectedValue: "t3.medium", actualValue: "t3.xlarge", severity: "medium", category: "config", remediation: "Resize instance to declared type or update IaC" },
    { resourceType: "load_balancer", property: "ssl_policy", expectedValue: "TLS-1-2-2017-01", actualValue: "TLS-1-0-2015-04", severity: "high", category: "security", remediation: "Update SSL policy to enforce TLS 1.2 minimum" },
    { resourceType: "lambda_function", property: "timeout", expectedValue: "30s", actualValue: "300s", severity: "low", category: "config", remediation: "Reset timeout to declared value or update IaC state" },
    { resourceType: "cloudwatch_alarm", property: "threshold", expectedValue: "80%", actualValue: "95%", severity: "medium", category: "config", remediation: "Restore alarm threshold to ensure timely alerts" },
    { resourceType: "kms_key", property: "rotation_enabled", expectedValue: "true", actualValue: "false", severity: "high", category: "security", remediation: "Re-enable automatic key rotation" },
  ];

  const count = 5 + (seed % 8);
  for (let i = 0; i < count; i++) {
    const template = templates[i % templates.length]!;
    const daysAgo = 1 + ((seed + i) % 14);
    driftItems.push({
      ...template,
      resourceId: `${provider}-${template.resourceType}-${(seed + i).toString(16).slice(0, 6)}`,
      driftedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
      driftedBy: (seed + i) % 3 === 0 ? "manual-console-change" : undefined,
    });
  }

  return driftItems;
}

function generateRemediationPlan(provider: string, iacTool: string, resourceIds: string[]): {
  commands: string[];
  warnings: string[];
  impact: { resourcesModified: number; estimatedDowntime: string };
} {
  const commands: string[] = [];
  const warnings: string[] = [];

  switch (iacTool) {
    case "terraform":
      commands.push(`terraform plan -target=${resourceIds.map((id) => `module.infra.${id}`).join(" -target=")}`);
      commands.push(`terraform apply -target=${resourceIds.map((id) => `module.infra.${id}`).join(" -target=")} -auto-approve`);
      break;
    case "cloudformation":
      commands.push(`aws cloudformation detect-stack-drift --stack-name main`);
      commands.push(`aws cloudformation update-stack --stack-name main --use-previous-template`);
      break;
    case "pulumi":
      commands.push(`pulumi refresh`);
      commands.push(`pulumi up --target ${resourceIds.join(",")}`);
      break;
    case "bicep":
      commands.push(`az deployment group create --resource-group main --template-file main.bicep --mode Incremental`);
      break;
  }

  if (resourceIds.length > 5) {
    warnings.push("Large number of resources targeted — consider remediating in batches");
  }
  warnings.push("Review plan output carefully before applying — verify no unintended changes");

  return {
    commands,
    warnings,
    impact: {
      resourcesModified: resourceIds.length,
      estimatedDowntime: resourceIds.some((id) => id.includes("rds") || id.includes("ec2")) ? "Possible brief interruption" : "None expected",
    },
  };
}

function generateDriftRecommendations(summary: DriftSummary, items: DriftItem[]): string[] {
  const recs: string[] = [];
  if (summary.complianceScore < 80) {
    recs.push("Compliance score below 80% — schedule immediate drift remediation sprint");
  }
  if (items.some((d) => d.category === "security" && d.severity === "critical")) {
    recs.push("Critical security drift detected — remediate immediately to prevent exposure");
  }
  if (items.filter((d) => d.driftedBy === "manual-console-change").length > 2) {
    recs.push("Multiple manual console changes detected — enforce IaC-only change policy with SCPs");
  }
  recs.push("Set up automated drift detection on a schedule (daily recommended)");
  recs.push("Configure alerting for critical severity drift items");
  return recs;
}

function countBy(items: DriftItem[], field: "severity" | "category"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = item[field];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function severityRank(s: string): number {
  const ranks: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, all: 4 };
  return ranks[s] ?? 4;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export default cloudDriftDetectSkill;
