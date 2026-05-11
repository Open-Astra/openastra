import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── health_scorecard ────────────────────────────────────────────────
// Agent health scorecard with periodic self-assessment. Scores agents
// on reliability, efficiency, memory hygiene, debate convergence,
// and overall health. Stores history for trend analysis.

const HealthScorecardParams = z.object({
  action: z
    .enum(["assess", "history", "compare", "recommendations"])
    .describe("Action: run assessment, view history, compare agents, or get improvement recommendations"),
  agent_id: z.string().optional().describe("Agent ID to assess (defaults to current agent)"),
  period_days: z.number().default(7).describe("Assessment period in days"),
});

registerTool({
  name: "health_scorecard",
  description:
    "Agent health scorecard. Assess reliability, efficiency, memory hygiene, and overall performance. Track trends over time and get improvement recommendations.",
  parameters: HealthScorecardParams,

  async execute(params, ctx) {
    const pool = getPool();
    const agentId = params.agent_id ?? ctx.agentId;
    const periodDays = params.period_days;

    switch (params.action) {
      case "assess": {
        const scores = await runAssessment(pool, ctx.uid, agentId, periodDays);

        // Persist scorecard
        await pool.query(
          `INSERT INTO agent_health_scores (uid, agent_id, scores, assessed_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [ctx.uid, agentId, JSON.stringify(scores)],
        ).catch(() => {});

        return {
          result: "Health assessment complete",
          agentId,
          period: `${periodDays} days`,
          ...scores,
        };
      }

      case "history": {
        const { rows } = await pool.query<{
          scores: HealthScores;
          assessed_at: string;
        }>(
          `SELECT scores, assessed_at FROM agent_health_scores
           WHERE uid = $1 AND agent_id = $2
           ORDER BY assessed_at DESC LIMIT 20`,
          [ctx.uid, agentId],
        );

        return {
          result: `${rows.length} assessment(s)`,
          agentId,
          history: rows.map((r) => ({
            overallScore: r.scores.overall,
            reliability: r.scores.reliability,
            efficiency: r.scores.efficiency,
            memoryHygiene: r.scores.memoryHygiene,
            assessedAt: r.assessed_at,
          })),
        };
      }

      case "compare": {
        // Get latest scores for all agents
        const { rows } = await pool.query<{
          agent_id: string;
          scores: HealthScores;
          assessed_at: string;
        }>(
          `SELECT DISTINCT ON (agent_id) agent_id, scores, assessed_at
           FROM agent_health_scores WHERE uid = $1
           ORDER BY agent_id, assessed_at DESC`,
          [ctx.uid],
        );

        const comparisons = rows.map((r) => ({
          agentId: r.agent_id,
          overall: r.scores.overall,
          reliability: r.scores.reliability,
          efficiency: r.scores.efficiency,
          memoryHygiene: r.scores.memoryHygiene,
          lastAssessed: r.assessed_at,
        }));

        comparisons.sort((a, b) => b.overall - a.overall);

        return {
          result: `${comparisons.length} agent(s) compared`,
          comparisons,
        };
      }

      case "recommendations": {
        const scores = await runAssessment(pool, ctx.uid, agentId, periodDays);
        const recommendations: string[] = [];

        if (scores.reliability < 70) {
          recommendations.push("Reliability is low. Review error logs and add retry logic for flaky operations.");
        }
        if (scores.efficiency < 70) {
          recommendations.push("Efficiency needs improvement. Consider reducing token usage per task by being more concise.");
        }
        if (scores.memoryHygiene < 70) {
          recommendations.push("Memory hygiene is poor. Run memory_compress to prune stale entries and low-score graph entities.");
        }
        if (scores.taskCompletion < 70) {
          recommendations.push("Task completion rate is low. Break complex tasks into smaller sub-tasks.");
        }
        if (scores.responseQuality < 70) {
          recommendations.push("Response quality could improve. Focus on providing more structured, actionable outputs.");
        }

        if (recommendations.length === 0) {
          recommendations.push("All health metrics are within acceptable ranges. Keep up the good work!");
        }

        return {
          result: `${recommendations.length} recommendation(s)`,
          agentId,
          currentScores: scores,
          recommendations,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

interface HealthScores {
  overall: number;
  reliability: number;
  efficiency: number;
  memoryHygiene: number;
  taskCompletion: number;
  responseQuality: number;
}

async function runAssessment(
  pool: ReturnType<typeof getPool>,
  uid: string,
  agentId: string,
  periodDays: number,
): Promise<HealthScores> {
  const since = new Date();
  since.setDate(since.getDate() - periodDays);
  const sinceStr = since.toISOString();

  // Reliability: based on error rate from audit logs
  const { rows: auditRows } = await pool.query<{ total: string; errors: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE value->>'success' = 'false' OR value->>'error' IS NOT NULL)::text AS errors
     FROM agent_audit_log
     WHERE uid = $1 AND agent_id = $2 AND created_at > $3`,
    [uid, agentId, sinceStr],
  );
  const totalActions = parseInt(auditRows[0]?.total ?? "0");
  const errorActions = parseInt(auditRows[0]?.errors ?? "0");
  const reliability = totalActions > 0 ? Math.round((1 - errorActions / totalActions) * 100) : 80;

  // Efficiency: average tokens per task from ledger
  const { rows: ledgerRows } = await pool.query<{ avg_tokens: string; avg_latency: string }>(
    `SELECT
       COALESCE(AVG(tokens_used), 0)::text AS avg_tokens,
       COALESCE(AVG(latency_ms), 0)::text AS avg_latency
     FROM execution_ledger
     WHERE uid = $1 AND timestamp > $2`,
    [uid, since.getTime()],
  );
  const avgTokens = parseFloat(ledgerRows[0]?.avg_tokens ?? "0");
  // Score efficiency: fewer tokens = higher score (capped at reasonable ranges)
  const efficiency = avgTokens > 0
    ? Math.min(100, Math.max(20, Math.round(100 - (avgTokens / 500))))
    : 75;

  // Memory hygiene: check for stale data and excessive entries
  const { rows: entityRows } = await pool.query<{ total: string; stale: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE reinforcement_score < 0.2 AND access_count <= 1)::text AS stale
     FROM graph_entities WHERE uid = $1`,
    [uid],
  );
  const totalEntities = parseInt(entityRows[0]?.total ?? "0");
  const staleEntities = parseInt(entityRows[0]?.stale ?? "0");
  const memoryHygiene = totalEntities > 0
    ? Math.round((1 - staleEntities / totalEntities) * 100)
    : 90;

  // Task completion: from swarm execution records
  const { rows: swarmRows } = await pool.query<{ total: string; completed: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status = 'completed')::text AS completed
     FROM swarms WHERE owner_id = $1 AND created_at > $2`,
    [uid, sinceStr],
  );
  const totalSwarms = parseInt(swarmRows[0]?.total ?? "0");
  const completedSwarms = parseInt(swarmRows[0]?.completed ?? "0");
  const taskCompletion = totalSwarms > 0
    ? Math.round((completedSwarms / totalSwarms) * 100)
    : 80;

  // Response quality: proxy from feedback/mood data
  const responseQuality = Math.round((reliability + efficiency + taskCompletion) / 3);

  const overall = Math.round(
    reliability * 0.25 + efficiency * 0.2 + memoryHygiene * 0.2 +
    taskCompletion * 0.2 + responseQuality * 0.15,
  );

  return { overall, reliability, efficiency, memoryHygiene, taskCompletion, responseQuality };
}
