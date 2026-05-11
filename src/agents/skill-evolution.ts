import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { z } from "zod";

const logger = createLogger("skill-evolution");

// ── Skill Feedback Schema ───────────────────────────────────────────

export const SkillFeedbackSchema = z.object({
  rating: z.number().int().min(1).max(5),
  duration_ms: z.number().nonnegative(),
  success: z.boolean(),
  user_comment: z.string().optional(),
});

export type SkillFeedback = z.infer<typeof SkillFeedbackSchema>;

export interface PerformanceAnalysis {
  skillId: string;
  agentId: string;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  successRate: number;
  executionCount: number;
  avgRating: number | null;
  trend: "improving" | "declining" | "stable";
  lastUpdatedAt: Date;
}

export interface Improvement {
  category: "input_sanitization" | "retry_strategy" | "parameter_hint" | "error_handling";
  description: string;
  severity: "low" | "medium" | "high";
  evidence: string;
}

// ── Record Skill Feedback ───────────────────────────────────────────
// Fire-and-forget logging of skill execution results for performance tracking

export async function recordSkillFeedback(
  skillId: string,
  agentId: string,
  feedback: SkillFeedback,
  ctx: { uid: string; workspaceId?: string },
): Promise<void> {
  try {
    const pool = getPool();
    const validated = SkillFeedbackSchema.parse(feedback);

    // Insert individual feedback record
    await pool.query(
      `INSERT INTO skill_performance (workspace_id, skill_id, agent_id, uid, rating, duration_ms, success, user_comment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        ctx.workspaceId ?? null,
        skillId,
        agentId,
        ctx.uid,
        validated.rating ?? null,
        validated.duration_ms,
        validated.success,
        validated.user_comment ?? null,
      ],
    );

    // Trigger async aggregation refresh
    updateSkillPerformanceAggregate(skillId, agentId).catch((err) => {
      logger.warn(`Failed to update skill aggregate for ${skillId}:${agentId}`, err);
    });
  } catch (err) {
    logger.warn(`Failed to record skill feedback for ${skillId}`, err);
  }
}

// ── Update Aggregate Stats ──────────────────────────────────────────

async function updateSkillPerformanceAggregate(skillId: string, agentId: string): Promise<void> {
  const pool = getPool();

  const stats = await pool.query<{
    execution_count: number;
    success_count: number;
    success_rate: number;
    avg_duration_ms: number;
    min_duration_ms: number;
    max_duration_ms: number;
    avg_rating: number | null;
  }>(
    `SELECT
       COUNT(*)::int as execution_count,
       SUM(CASE WHEN success THEN 1 ELSE 0 END)::int as success_count,
       ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / COUNT(*), 2) as success_rate,
       ROUND(AVG(duration_ms)::numeric, 2) as avg_duration_ms,
       MIN(duration_ms) as min_duration_ms,
       MAX(duration_ms) as max_duration_ms,
       ROUND(AVG(rating)::numeric, 2) as avg_rating
     FROM skill_performance
     WHERE skill_id = $1 AND agent_id = $2`,
    [skillId, agentId],
  );

  const row = stats.rows[0];
  if (!row || row.execution_count === 0) return;

  // Calculate trend: compare last 3 executions vs avg of all
  const trend = await calculateTrend(skillId, agentId);

  await pool.query(
    `INSERT INTO skill_performance_aggregate
     (skill_id, agent_id, execution_count, success_count, success_rate, avg_duration_ms, min_duration_ms, max_duration_ms, avg_rating, trend, last_updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (skill_id, agent_id) DO UPDATE SET
       execution_count = EXCLUDED.execution_count,
       success_count = EXCLUDED.success_count,
       success_rate = EXCLUDED.success_rate,
       avg_duration_ms = EXCLUDED.avg_duration_ms,
       min_duration_ms = EXCLUDED.min_duration_ms,
       max_duration_ms = EXCLUDED.max_duration_ms,
       avg_rating = EXCLUDED.avg_rating,
       trend = EXCLUDED.trend,
       last_updated_at = NOW()`,
    [
      skillId,
      agentId,
      row.execution_count,
      row.success_count,
      row.success_rate,
      row.avg_duration_ms,
      row.min_duration_ms,
      row.max_duration_ms,
      row.avg_rating,
      trend,
    ],
  );
}

async function calculateTrend(skillId: string, agentId: string): Promise<"improving" | "declining" | "stable"> {
  const pool = getPool();

  const result = await pool.query<{
    recent_success: string;
    overall_success: string;
  }>(
    `SELECT
       ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / COUNT(*), 3) as recent_success,
       (SELECT ROUND(SUM(CASE WHEN success THEN 1 ELSE 0 END)::numeric / COUNT(*), 3)
        FROM skill_performance WHERE skill_id = $1 AND agent_id = $2) as overall_success
     FROM (
       SELECT success FROM skill_performance
       WHERE skill_id = $1 AND agent_id = $2
       ORDER BY created_at DESC LIMIT 5
     ) recent`,
    [skillId, agentId],
  );

  const row = result.rows[0];
  if (!row) return "stable";

  const recent = parseFloat(row.recent_success ?? "0");
  const overall = parseFloat(row.overall_success ?? "0");
  const diff = recent - overall;

  if (diff > 0.1) return "improving";
  if (diff < -0.1) return "declining";
  return "stable";
}

// ── Analyze Skill Performance ───────────────────────────────────────

export async function analyzeSkillPerformance(
  skillId: string,
  agentId: string,
): Promise<PerformanceAnalysis | null> {
  const pool = getPool();

  const result = await pool.query<{
    execution_count: number;
    success_rate: number;
    avg_duration_ms: string;
    min_duration_ms: number;
    max_duration_ms: number;
    avg_rating: string | null;
    trend: string;
    last_updated_at: Date;
  }>(
    `SELECT
       execution_count, success_rate, avg_duration_ms, min_duration_ms, max_duration_ms,
       avg_rating, trend, last_updated_at
     FROM skill_performance_aggregate
     WHERE skill_id = $1 AND agent_id = $2`,
    [skillId, agentId],
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  return {
    skillId,
    agentId,
    avgDuration: parseFloat(row.avg_duration_ms),
    minDuration: row.min_duration_ms,
    maxDuration: row.max_duration_ms,
    successRate: parseFloat(row.success_rate.toString()),
    executionCount: row.execution_count,
    avgRating: row.avg_rating ? parseFloat(row.avg_rating) : null,
    trend: (row.trend as "improving" | "declining" | "stable") || "stable",
    lastUpdatedAt: row.last_updated_at,
  };
}

// ── Suggest Improvements ────────────────────────────────────────────

export async function suggestSkillImprovements(skillId: string): Promise<Improvement[]> {
  const pool = getPool();
  const improvements: Improvement[] = [];

  // Check success rate < 70% over 5+ executions
  const perf = await pool.query<{
    execution_count: number;
    success_rate: string;
  }>(
    `SELECT execution_count, success_rate FROM skill_performance_aggregate
     WHERE skill_id = $1`,
    [skillId],
  );

  if (perf.rows.length === 0) return improvements;

  const row = perf.rows[0];
  const successRate = parseFloat(row.success_rate);

  if (row.execution_count >= 5 && successRate < 0.7) {
    // Analyze error patterns
    const errors = await pool.query<{
      error_pattern: string;
      count: number;
    }>(
      `SELECT error_pattern, COUNT(*)::int as count
       FROM (
         SELECT
           CASE
             WHEN user_comment ILIKE '%special%char%' THEN 'special_chars'
             WHEN user_comment ILIKE '%timeout%' THEN 'timeout'
             WHEN user_comment ILIKE '%invalid%input%' THEN 'invalid_input'
             ELSE 'other'
           END as error_pattern
         FROM skill_performance WHERE skill_id = $1 AND NOT success
       ) patterns
       GROUP BY error_pattern ORDER BY count DESC`,
      [skillId],
    );

    if (errors.rows.length > 0) {
      const top = errors.rows[0];
      if (top?.error_pattern === "special_chars") {
        improvements.push({
          category: "input_sanitization",
          description: "Tool fails on inputs with special characters; consider pre-sanitization or escaping",
          severity: "high",
          evidence: `${top.count} failures related to special characters`,
        });
      } else if (top?.error_pattern === "timeout") {
        improvements.push({
          category: "retry_strategy",
          description: "Multiple timeout failures detected; increase retry delay or timeout duration",
          severity: "high",
          evidence: `${top.count} timeout failures`,
        });
      } else if (top?.error_pattern === "invalid_input") {
        improvements.push({
          category: "parameter_hint",
          description: "Invalid input parameter errors; add stricter validation in prompt context",
          severity: "medium",
          evidence: `${top.count} invalid input failures`,
        });
      }
    }
  }

  // Check average duration > 10s
  const avgDur = await pool.query<{ avg_duration_ms: string }>(
    `SELECT avg_duration_ms FROM skill_performance_aggregate WHERE skill_id = $1`,
    [skillId],
  );

  if (avgDur.rows[0]) {
    const avgMs = parseFloat(avgDur.rows[0].avg_duration_ms);
    if (avgMs > 10000) {
      improvements.push({
        category: "error_handling",
        description: "Average execution duration exceeds 10s; consider optimizing or adding early termination logic",
        severity: "low",
        evidence: `Average duration: ${(avgMs / 1000).toFixed(1)}s`,
      });
    }
  }

  return improvements;
}

// ── Evolve Skill Prompt ─────────────────────────────────────────────
// Use Claude to generate improved system prompt based on feedback

export async function evolveSkillPrompt(skillId: string): Promise<{
  updatedPrompt: string;
  reasoning: string;
} | null> {
  const improvements = await suggestSkillImprovements(skillId);
  if (improvements.length === 0) return null;

  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const prompt = `
You are an AI system prompt engineer. Given feedback about a failing skill, generate an improved system prompt that addresses the issues.

Skill ID: ${skillId}
Issues detected:
${improvements.map((imp) => `- [${imp.severity}] ${imp.category}: ${imp.description}\n  Evidence: ${imp.evidence}`).join("\n")}

Generate an improved system prompt section (100-200 words) that:
1. Addresses each issue with specific guidance
2. Maintains clarity and conciseness
3. Is actionable for the LLM executing the skill

Format your response as:
PROMPT:
[improved prompt here]

REASONING:
[brief explanation of changes]
`;

    const response = await client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    const promptMatch = text.match(/PROMPT:\n([\s\S]*?)\n\nREASONING:/);
    const reasoningMatch = text.match(/REASONING:\n([\s\S]*?)$/);

    if (!promptMatch || !reasoningMatch) {
      logger.warn(`Failed to parse Claude response for skill ${skillId}`);
      return null;
    }

    return {
      updatedPrompt: promptMatch[1].trim(),
      reasoning: reasoningMatch[1].trim(),
    };
  } catch (err) {
    logger.warn(`Failed to evolve skill prompt for ${skillId}`, err);
    return null;
  }
}
