import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── ethical_check ───────────────────────────────────────────────────
// Post-generation ethical alignment validator. Checks agent outputs
// against configurable ethical guidelines covering bias, safety,
// privacy, accuracy, and harm. Returns a scored assessment.

const EthicalCheckParams = z.object({
  action: z
    .enum(["check", "configure", "report", "get_guidelines"])
    .describe("Action: check content, configure guidelines, get report, or view guidelines"),
  content: z.string().optional().describe("Content to check (for check action)"),
  context: z.string().optional().describe("Context in which the content was generated"),
  guidelines: z
    .array(
      z.object({
        category: z.string().describe("Guideline category"),
        rule: z.string().describe("The ethical rule or principle"),
        severity: z.enum(["block", "warn", "info"]).describe("Violation severity"),
      }),
    )
    .optional()
    .describe("Custom ethical guidelines (for configure action)"),
});

const DEFAULT_GUIDELINES = [
  { category: "bias", rule: "Content should not contain stereotypes or discriminatory language", severity: "block" as const },
  { category: "bias", rule: "Recommendations should consider diverse perspectives", severity: "warn" as const },
  { category: "safety", rule: "Content should not provide instructions for harmful activities", severity: "block" as const },
  { category: "safety", rule: "Medical/legal/financial advice should include disclaimer", severity: "warn" as const },
  { category: "privacy", rule: "Content should not expose personal identifiable information", severity: "block" as const },
  { category: "privacy", rule: "Data handling recommendations should follow GDPR principles", severity: "info" as const },
  { category: "accuracy", rule: "Claims should be verifiable or clearly marked as opinions", severity: "warn" as const },
  { category: "accuracy", rule: "Statistics should include sources when available", severity: "info" as const },
  { category: "harm", rule: "Content should not encourage self-harm or violence", severity: "block" as const },
  { category: "transparency", rule: "AI-generated content should be identifiable as such", severity: "info" as const },
];

// Pattern-based checks for common ethical issues
const ETHICAL_PATTERNS: Array<{
  pattern: RegExp;
  category: string;
  message: string;
  severity: "block" | "warn" | "info";
}> = [
  {
    pattern: /\b(?:all|every|no)\s+(?:men|women|people\s+from|members\s+of)\b/i,
    category: "bias",
    message: "Absolute generalization about a group detected",
    severity: "warn",
  },
  {
    pattern: /\b(?:obviously|clearly|everyone\s+knows)\b/i,
    category: "accuracy",
    message: "Unsupported absolute claim detected",
    severity: "info",
  },
  {
    pattern: /\b(?:SSN|social\s+security|credit\s+card\s+number|passport\s+number)\b.*\d{3,}/i,
    category: "privacy",
    message: "Possible PII exposure detected",
    severity: "block",
  },
  {
    pattern: /\b(?:you\s+should\s+(?:take|stop\s+taking)\s+(?:medication|medicine|drugs))\b/i,
    category: "safety",
    message: "Direct medical advice detected without disclaimer",
    severity: "warn",
  },
  {
    pattern: /\b(?:guaranteed|100%\s+(?:safe|effective|accurate)|never\s+fails)\b/i,
    category: "accuracy",
    message: "Misleading absolute guarantee detected",
    severity: "warn",
  },
];

registerTool({
  name: "ethical_check",
  description:
    "Ethical alignment validator for agent outputs. Checks content against configurable guidelines for bias, safety, privacy, accuracy, and harm. Returns scored assessment with specific violations.",
  parameters: EthicalCheckParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "check": {
        if (!params.content) return { error: "content required for check" };

        // Load custom guidelines if configured
        const { rows: configRows } = await pool.query<{
          value: { guidelines: typeof DEFAULT_GUIDELINES };
        }>(
          `SELECT value FROM agent_ethical_configs WHERE uid = $1 LIMIT 1`,
          [ctx.uid],
        );

        const guidelines = configRows.length > 0
          ? configRows[0]!.value.guidelines
          : DEFAULT_GUIDELINES;

        const violations: Array<{
          category: string;
          severity: string;
          message: string;
          guideline: string;
        }> = [];

        // Pattern-based detection
        for (const check of ETHICAL_PATTERNS) {
          if (check.pattern.test(params.content)) {
            violations.push({
              category: check.category,
              severity: check.severity,
              message: check.message,
              guideline: guidelines.find((g) => g.category === check.category)?.rule ?? "",
            });
          }
        }

        // Category scores (0-100, higher = more ethical)
        const categories = [...new Set(guidelines.map((g) => g.category))];
        const scores: Record<string, number> = {};

        for (const cat of categories) {
          const catViolations = violations.filter((v) => v.category === cat);
          const blockCount = catViolations.filter((v) => v.severity === "block").length;
          const warnCount = catViolations.filter((v) => v.severity === "warn").length;
          const infoCount = catViolations.filter((v) => v.severity === "info").length;
          scores[cat] = Math.max(0, 100 - blockCount * 40 - warnCount * 15 - infoCount * 5);
        }

        const overallScore = categories.length > 0
          ? Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / categories.length)
          : 100;

        const blocked = violations.some((v) => v.severity === "block");

        // Log the check
        await pool.query(
          `INSERT INTO ethical_check_log (uid, agent_id, content_hash, score, violations, checked_at)
           VALUES ($1, $2, md5($3), $4, $5::jsonb, NOW())`,
          [ctx.uid, ctx.agentId, params.content, overallScore, JSON.stringify(violations)],
        ).catch(() => {}); // best-effort logging

        return {
          result: blocked ? "BLOCKED — ethical violation" : "PASSED",
          overallScore,
          categoryScores: scores,
          violationCount: violations.length,
          blocked,
          violations,
        };
      }

      case "configure": {
        if (!params.guidelines) return { error: "guidelines required for configure" };

        await pool.query(
          `INSERT INTO agent_ethical_configs (uid, value, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (uid) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
          [ctx.uid, JSON.stringify({ guidelines: params.guidelines })],
        );

        return {
          result: "Ethical guidelines configured",
          guidelineCount: params.guidelines.length,
        };
      }

      case "report": {
        const { rows } = await pool.query<{
          score: number;
          violations: unknown[];
          checked_at: string;
        }>(
          `SELECT score, violations, checked_at FROM ethical_check_log
           WHERE uid = $1 ORDER BY checked_at DESC LIMIT 50`,
          [ctx.uid],
        );

        if (rows.length === 0) return { result: "No ethical checks recorded" };

        const avgScore = Math.round(rows.reduce((sum, r) => sum + r.score, 0) / rows.length);
        const totalViolations = rows.reduce(
          (sum, r) => sum + (Array.isArray(r.violations) ? r.violations.length : 0),
          0,
        );

        return {
          result: `Ethical report: ${rows.length} checks`,
          averageScore: avgScore,
          totalChecks: rows.length,
          totalViolations,
          trend: rows.slice(0, 5).map((r) => ({
            score: r.score,
            violations: Array.isArray(r.violations) ? r.violations.length : 0,
            checkedAt: r.checked_at,
          })),
        };
      }

      case "get_guidelines": {
        const { rows } = await pool.query<{
          value: { guidelines: typeof DEFAULT_GUIDELINES };
        }>(
          "SELECT value FROM agent_ethical_configs WHERE uid = $1 LIMIT 1",
          [ctx.uid],
        );

        const guidelines = rows.length > 0 ? rows[0]!.value.guidelines : DEFAULT_GUIDELINES;
        return {
          result: `${guidelines.length} active guidelines`,
          guidelines,
          isCustom: rows.length > 0,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
