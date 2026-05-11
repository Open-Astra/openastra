import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";
import { execSync } from "node:child_process";
import { safeFetch } from "../../helpers/http.js";

// ── Dependency Check Skill ──────────────────────────────────────────
// Audit npm/pip packages for vulnerabilities and outdated versions.

const NpmAuditParams = z.object({
  path: z.string().optional().describe("Project path (default: cwd)"),
});

const CheckPackageParams = z.object({
  name: z.string().describe("npm package name"),
  version: z.string().optional().describe("Current version to check"),
});

const OutdatedParams = z.object({
  path: z.string().optional().describe("Project path (default: cwd)"),
});

const dependencyCheckSkill: SkillDefinition = {
  name: "dependency_check",
  version: "1.0.0",

  manifest: {
    id: "dependency_check",
    name: "Dependency Check",
    description: "Audit npm packages for vulnerabilities, check for outdated dependencies, and inspect package info.",
    category: "analyze",
    tools: ["dep_audit", "dep_check_package", "dep_outdated"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "dep_audit",
      description: "Run npm audit to find known vulnerabilities in project dependencies.",
      parameters: NpmAuditParams,

      async execute(params) {
        const cwd = params.path ?? process.cwd();
        try {
          const output = execSync("npm audit --json 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 30_000 });
          const data = JSON.parse(output) as {
            vulnerabilities?: Record<string, { severity: string; name: string; range: string; fixAvailable?: boolean | { name: string; version: string } }>;
            metadata?: { vulnerabilities: Record<string, number> };
          };

          const vulns = Object.values(data.vulnerabilities ?? {}).map((v) => ({
            package: v.name,
            severity: v.severity,
            range: v.range,
            fixAvailable: !!v.fixAvailable,
          }));

          return {
            totalVulnerabilities: vulns.length,
            bySeverity: data.metadata?.vulnerabilities ?? {},
            vulnerabilities: vulns.slice(0, 20),
          };
        } catch (err) {
          return { error: `npm audit failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
        }
      },
    });

    ctx.registerTool({
      name: "dep_check_package",
      description: "Check an npm package's latest version, description, and download stats.",
      parameters: CheckPackageParams,

      async execute(params) {
        const res = await safeFetch(`https://registry.npmjs.org/${encodeURIComponent(params.name)}`, { ssrfProtection: false });
        if (!res.ok) return { error: `npm registry returned ${res.status} for ${params.name}` };

        const data = (await res.json()) as {
          name: string;
          description?: string;
          "dist-tags"?: { latest?: string };
          versions?: Record<string, unknown>;
          time?: Record<string, string>;
          license?: string;
        };

        const latest = data["dist-tags"]?.latest ?? "unknown";
        const versions = Object.keys(data.versions ?? {});

        const result: Record<string, unknown> = {
          name: data.name,
          description: data.description,
          latestVersion: latest,
          totalVersions: versions.length,
          license: data.license,
          lastPublished: data.time?.[latest] ?? data.time?.modified,
        };

        if (params.version) {
          result.currentVersion = params.version;
          result.isLatest = params.version === latest;
          result.versionsBehind = versions.indexOf(latest) - versions.indexOf(params.version);
        }

        return result;
      },
    });

    ctx.registerTool({
      name: "dep_outdated",
      description: "List outdated npm dependencies in a project.",
      parameters: OutdatedParams,

      async execute(params) {
        const cwd = params.path ?? process.cwd();
        try {
          const output = execSync("npm outdated --json 2>/dev/null || true", { cwd, encoding: "utf-8", timeout: 30_000 });
          const data = JSON.parse(output || "{}") as Record<string, { current: string; wanted: string; latest: string; type: string }>;

          const packages = Object.entries(data).map(([name, info]) => ({
            name,
            current: info.current,
            wanted: info.wanted,
            latest: info.latest,
            type: info.type,
            major: info.current !== info.latest && info.current.split(".")[0] !== info.latest.split(".")[0],
          }));

          return {
            totalOutdated: packages.length,
            majorUpdates: packages.filter((p) => p.major).length,
            packages: packages.slice(0, 30),
          };
        } catch (err) {
          return { error: `npm outdated failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
        }
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "dependency_check",
      instructions: "You can audit dependencies with `dep_audit` (find vulnerabilities), `dep_check_package` (check specific package info/version), and `dep_outdated` (list outdated packages).",
    };
  },
};

export default dependencyCheckSkill;
