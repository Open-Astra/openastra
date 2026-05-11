import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── evolution_feedback ──────────────────────────────────────────────
// Agent evolution feedback loop. Wraps persona evolution and optimizer
// A/B testing with automated feedback collection, performance scoring,
// and goal-driven evolution.

const EvolutionFeedbackParams = z.object({
  action: z
    .enum(["feedback", "set_goals", "progress", "evolve", "history"])
    .describe("Action: submit feedback, set evolution goals, check progress, trigger evolution, or view history"),
  feedback: z
    .object({
      quality: z.number().min(1).max(5).describe("Quality score 1-5"),
      relevance: z.number().min(1).max(5).describe("Relevance score 1-5"),
      helpfulness: z.number().min(1).max(5).describe("Helpfulness score 1-5"),
      comment: z.string().optional().describe("Free-text feedback"),
    })
    .optional()
    .describe("Feedback scores (for feedback action)"),
  goals: z
    .array(
      z.object({
        metric: z.string().describe("What to optimize (e.g., 'conciseness', 'accuracy', 'creativity')"),
        target: z.number().describe("Target score (1-5)"),
        weight: z.number().default(1).describe("Relative importance"),
      }),
    )
    .optional()
    .describe("Evolution goals (for set_goals action)"),
  context: z.string().optional().describe("Context for the feedback (task type, etc.)"),
});

registerTool({
  name: "evolution_feedback",
  description:
    "Agent evolution feedback loop. Collect performance feedback, set optimization goals, track progress toward goals, and trigger persona evolution based on accumulated data.",
  parameters: EvolutionFeedbackParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "feedback": {
        if (!params.feedback) return { error: "feedback required" };

        const entry = {
          ...params.feedback,
          context: params.context ?? "general",
          agentId: ctx.agentId,
          timestamp: Date.now(),
        };

        await pool.query(
          `INSERT INTO evolution_feedback (uid, agent_id, value, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [ctx.uid, ctx.agentId, JSON.stringify(entry)],
        );

        // Calculate running average
        const { rows } = await pool.query<{
          avg_quality: string;
          avg_relevance: string;
          avg_helpfulness: string;
          count: string;
        }>(
          `SELECT
             AVG((value->>'quality')::float)::text AS avg_quality,
             AVG((value->>'relevance')::float)::text AS avg_relevance,
             AVG((value->>'helpfulness')::float)::text AS avg_helpfulness,
             COUNT(*)::text AS count
           FROM evolution_feedback WHERE uid = $1 AND agent_id = $2`,
          [ctx.uid, ctx.agentId],
        );

        return {
          result: "Feedback recorded",
          submitted: params.feedback,
          runningAverages: {
            quality: Math.round(parseFloat(rows[0]?.avg_quality ?? "0") * 100) / 100,
            relevance: Math.round(parseFloat(rows[0]?.avg_relevance ?? "0") * 100) / 100,
            helpfulness: Math.round(parseFloat(rows[0]?.avg_helpfulness ?? "0") * 100) / 100,
            totalFeedback: parseInt(rows[0]?.count ?? "0"),
          },
        };
      }

      case "set_goals": {
        if (!params.goals) return { error: "goals required" };

        await pool.query(
          `INSERT INTO evolution_goals (uid, agent_id, goals, updated_at)
           VALUES ($1, $2, $3::jsonb, NOW())
           ON CONFLICT (uid, agent_id) DO UPDATE SET goals = $3::jsonb, updated_at = NOW()`,
          [ctx.uid, ctx.agentId, JSON.stringify(params.goals)],
        );

        return {
          result: "Evolution goals set",
          agentId: ctx.agentId,
          goalCount: params.goals.length,
          goals: params.goals,
        };
      }

      case "progress": {
        // Get goals
        const { rows: goalRows } = await pool.query<{
          goals: Array<{ metric: string; target: number; weight: number }>;
        }>(
          "SELECT goals FROM evolution_goals WHERE uid = $1 AND agent_id = $2",
          [ctx.uid, ctx.agentId],
        );

        if (goalRows.length === 0) return { error: "No goals set. Use set_goals first." };

        const goals = goalRows[0]!.goals;

        // Get recent feedback averages
        const { rows: feedbackRows } = await pool.query<{
          avg_quality: string;
          avg_relevance: string;
          avg_helpfulness: string;
          count: string;
        }>(
          `SELECT
             AVG((value->>'quality')::float)::text AS avg_quality,
             AVG((value->>'relevance')::float)::text AS avg_relevance,
             AVG((value->>'helpfulness')::float)::text AS avg_helpfulness,
             COUNT(*)::text AS count
           FROM evolution_feedback
           WHERE uid = $1 AND agent_id = $2 AND created_at > NOW() - INTERVAL '7 days'`,
          [ctx.uid, ctx.agentId],
        );

        const currentScores: Record<string, number> = {
          quality: parseFloat(feedbackRows[0]?.avg_quality ?? "3"),
          relevance: parseFloat(feedbackRows[0]?.avg_relevance ?? "3"),
          helpfulness: parseFloat(feedbackRows[0]?.avg_helpfulness ?? "3"),
          conciseness: 3, // Default if not tracked
          accuracy: 3,
          creativity: 3,
        };

        const progress = goals.map((goal) => {
          const current = currentScores[goal.metric] ?? 3;
          const gap = goal.target - current;
          const progressPct = Math.min(100, Math.max(0, Math.round((current / goal.target) * 100)));

          return {
            metric: goal.metric,
            target: goal.target,
            current: Math.round(current * 100) / 100,
            gap: Math.round(gap * 100) / 100,
            progress: `${progressPct}%`,
            status: progressPct >= 100 ? "achieved" : progressPct >= 75 ? "on_track" : "needs_work",
          };
        });

        const overallProgress = Math.round(
          progress.reduce((sum, p) => sum + parseInt(p.progress), 0) / progress.length,
        );

        return {
          result: "Evolution progress",
          agentId: ctx.agentId,
          overallProgress: `${overallProgress}%`,
          feedbackCount: parseInt(feedbackRows[0]?.count ?? "0"),
          goals: progress,
        };
      }

      case "evolve": {
        // Check if there's enough feedback data
        const { rows: countRows } = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM evolution_feedback
           WHERE uid = $1 AND agent_id = $2`,
          [ctx.uid, ctx.agentId],
        );
        const feedbackCount = parseInt(countRows[0]?.count ?? "0");

        if (feedbackCount < 5) {
          return {
            error: `Insufficient feedback data (${feedbackCount}/5 minimum). Collect more feedback before evolving.`,
          };
        }

        // Get feedback trends
        const { rows: trendRows } = await pool.query<{
          avg_quality: string;
          avg_relevance: string;
          avg_helpfulness: string;
        }>(
          `SELECT
             AVG((value->>'quality')::float)::text AS avg_quality,
             AVG((value->>'relevance')::float)::text AS avg_relevance,
             AVG((value->>'helpfulness')::float)::text AS avg_helpfulness
           FROM evolution_feedback
           WHERE uid = $1 AND agent_id = $2`,
          [ctx.uid, ctx.agentId],
        );

        const avgQuality = parseFloat(trendRows[0]?.avg_quality ?? "3");
        const avgRelevance = parseFloat(trendRows[0]?.avg_relevance ?? "3");
        const avgHelpfulness = parseFloat(trendRows[0]?.avg_helpfulness ?? "3");

        // Generate evolution recommendations
        const recommendations: string[] = [];
        if (avgQuality < 3.5) recommendations.push("Improve output quality — consider more detailed analysis");
        if (avgRelevance < 3.5) recommendations.push("Improve relevance — focus more tightly on user's question");
        if (avgHelpfulness < 3.5) recommendations.push("Improve helpfulness — provide more actionable suggestions");
        if (avgQuality >= 4 && avgRelevance >= 4 && avgHelpfulness >= 4) {
          recommendations.push("Strong performance across all metrics — consider expanding capabilities");
        }

        // Record evolution event
        await pool.query(
          `INSERT INTO evolution_events (uid, agent_id, value, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [ctx.uid, ctx.agentId, JSON.stringify({
            feedbackCount,
            avgScores: { quality: avgQuality, relevance: avgRelevance, helpfulness: avgHelpfulness },
            recommendations,
            timestamp: Date.now(),
          })],
        );

        return {
          result: "Evolution analysis complete",
          feedbackCount,
          averageScores: {
            quality: Math.round(avgQuality * 100) / 100,
            relevance: Math.round(avgRelevance * 100) / 100,
            helpfulness: Math.round(avgHelpfulness * 100) / 100,
          },
          recommendations,
        };
      }

      case "history": {
        const { rows } = await pool.query<{
          value: {
            feedbackCount: number;
            avgScores: Record<string, number>;
            recommendations: string[];
            timestamp: number;
          };
          created_at: string;
        }>(
          `SELECT value, created_at FROM evolution_events
           WHERE uid = $1 AND agent_id = $2
           ORDER BY created_at DESC LIMIT 10`,
          [ctx.uid, ctx.agentId],
        );

        return {
          result: `${rows.length} evolution event(s)`,
          events: rows.map((r) => ({
            feedbackCount: r.value.feedbackCount,
            avgScores: r.value.avgScores,
            recommendations: r.value.recommendations,
            date: r.created_at,
          })),
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
