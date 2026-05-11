import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── memory_feedback ─────────────────────────────────────────────────
// Post-synthesis memory feedback loops. Agents report which memory
// entries were useful/irrelevant during tasks. Feedback is aggregated
// to fine-tune future RRF search weights and trigger autonomous
// pruning of consistently low-value entries.

const MemoryFeedbackParams = z.object({
  action: z
    .enum(["rate", "bulk_rate", "analyze", "auto_prune", "weights"])
    .describe("Action: rate a memory entry, bulk rate, analyze feedback patterns, auto-prune low-value entries, or view/adjust RRF weights"),
  memory_ref: z
    .object({
      tier: z.enum(["daily", "profile", "graph", "session"]).describe("Memory tier"),
      id: z.string().optional().describe("Entry ID or date (for daily)"),
      content_preview: z.string().optional().describe("Brief content for identification"),
    })
    .optional()
    .describe("Memory entry reference (for rate action)"),
  rating: z
    .enum(["very_useful", "useful", "neutral", "irrelevant", "misleading"])
    .optional()
    .describe("Utility rating (for rate action)"),
  context: z.string().optional().describe("Task context when this memory was used"),
  ratings: z
    .array(z.object({
      tier: z.enum(["daily", "profile", "graph", "session"]),
      id: z.string().optional(),
      content_preview: z.string().optional(),
      rating: z.enum(["very_useful", "useful", "neutral", "irrelevant", "misleading"]),
    }))
    .optional()
    .describe("Bulk ratings (for bulk_rate action)"),
  weights: z
    .object({
      daily: z.number().optional(),
      profile: z.number().optional(),
      graph: z.number().optional(),
      session: z.number().optional(),
    })
    .optional()
    .describe("Custom RRF weights per tier (for weights action)"),
});

const RATING_SCORES: Record<string, number> = {
  very_useful: 2,
  useful: 1,
  neutral: 0,
  irrelevant: -1,
  misleading: -2,
};

registerTool({
  name: "memory_feedback",
  description:
    "Post-synthesis memory feedback loops. Rate memory utility after tasks, analyze feedback patterns, auto-prune consistently irrelevant entries, and adjust RRF tier weights based on accumulated feedback.",
  parameters: MemoryFeedbackParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "rate": {
        if (!params.memory_ref || !params.rating) {
          return { error: "memory_ref and rating required" };
        }

        const id = randomUUID();
        const feedback = {
          tier: params.memory_ref.tier,
          entryId: params.memory_ref.id,
          contentPreview: params.memory_ref.content_preview?.slice(0, 200),
          rating: params.rating,
          score: RATING_SCORES[params.rating] ?? 0,
          context: params.context ?? "general",
          agentId: ctx.agentId,
          timestamp: Date.now(),
        };

        await pool.query(
          `INSERT INTO memory_feedback (id, uid, value, created_at)
           VALUES ($1, $2, $3::jsonb, NOW())`,
          [id, ctx.uid, JSON.stringify(feedback)],
        );

        return {
          result: "Memory feedback recorded",
          feedbackId: id,
          tier: params.memory_ref.tier,
          rating: params.rating,
          score: feedback.score,
        };
      }

      case "bulk_rate": {
        if (!params.ratings || params.ratings.length === 0) {
          return { error: "ratings required for bulk_rate" };
        }

        let recorded = 0;
        for (const rating of params.ratings) {
          const id = randomUUID();
          await pool.query(
            `INSERT INTO memory_feedback (id, uid, value, created_at)
             VALUES ($1, $2, $3::jsonb, NOW())`,
            [id, ctx.uid, JSON.stringify({
              tier: rating.tier,
              entryId: rating.id,
              contentPreview: rating.content_preview?.slice(0, 200),
              rating: rating.rating,
              score: RATING_SCORES[rating.rating] ?? 0,
              context: params.context ?? "general",
              agentId: ctx.agentId,
              timestamp: Date.now(),
            })],
          );
          recorded++;
        }

        return { result: `${recorded} feedback entries recorded` };
      }

      case "analyze": {
        // Aggregate feedback by tier
        const { rows: tierStats } = await pool.query<{
          tier: string;
          count: string;
          avg_score: string;
          useful_count: string;
          irrelevant_count: string;
        }>(
          `SELECT
             value->>'tier' AS tier,
             COUNT(*)::text AS count,
             AVG((value->>'score')::float)::text AS avg_score,
             COUNT(*) FILTER (WHERE (value->>'score')::float > 0)::text AS useful_count,
             COUNT(*) FILTER (WHERE (value->>'score')::float < 0)::text AS irrelevant_count
           FROM memory_feedback WHERE uid = $1
           GROUP BY value->>'tier'`,
          [ctx.uid],
        );

        // Recent feedback trend
        const { rows: recentRows } = await pool.query<{
          avg_score: string;
          count: string;
        }>(
          `SELECT AVG((value->>'score')::float)::text AS avg_score, COUNT(*)::text AS count
           FROM memory_feedback WHERE uid = $1 AND created_at > NOW() - INTERVAL '7 days'`,
          [ctx.uid],
        );

        // Identify worst-performing entries
        const { rows: worstEntries } = await pool.query<{
          tier: string;
          entry_id: string;
          content_preview: string;
          avg_score: string;
          feedback_count: string;
        }>(
          `SELECT
             value->>'tier' AS tier,
             value->>'entryId' AS entry_id,
             value->>'contentPreview' AS content_preview,
             AVG((value->>'score')::float)::text AS avg_score,
             COUNT(*)::text AS feedback_count
           FROM memory_feedback
           WHERE uid = $1 AND value->>'entryId' IS NOT NULL
           GROUP BY value->>'tier', value->>'entryId', value->>'contentPreview'
           HAVING AVG((value->>'score')::float) < -0.5 AND COUNT(*) >= 2
           ORDER BY AVG((value->>'score')::float) ASC LIMIT 10`,
          [ctx.uid],
        );

        // Recommended RRF weight adjustments
        const weightRecommendations: Record<string, number> = {};
        for (const stat of tierStats) {
          const avgScore = parseFloat(stat.avg_score);
          // Higher avg score → higher weight
          weightRecommendations[stat.tier] = Math.max(0.1, Math.min(1.0,
            0.5 + avgScore * 0.2,
          ));
        }

        return {
          result: "Memory feedback analysis",
          byTier: tierStats.map((r) => ({
            tier: r.tier,
            totalFeedback: parseInt(r.count),
            avgScore: Math.round(parseFloat(r.avg_score) * 100) / 100,
            usefulCount: parseInt(r.useful_count),
            irrelevantCount: parseInt(r.irrelevant_count),
          })),
          recentTrend: {
            avgScore: Math.round(parseFloat(recentRows[0]?.avg_score ?? "0") * 100) / 100,
            count: parseInt(recentRows[0]?.count ?? "0"),
          },
          worstEntries: worstEntries.map((r) => ({
            tier: r.tier,
            entryId: r.entry_id,
            contentPreview: r.content_preview,
            avgScore: Math.round(parseFloat(r.avg_score) * 100) / 100,
            feedbackCount: parseInt(r.feedback_count),
          })),
          recommendedWeights: weightRecommendations,
        };
      }

      case "auto_prune": {
        // Find entries consistently rated as irrelevant/misleading
        const { rows: pruneTargets } = await pool.query<{
          tier: string;
          entry_id: string;
          avg_score: string;
          feedback_count: string;
        }>(
          `SELECT
             value->>'tier' AS tier,
             value->>'entryId' AS entry_id,
             AVG((value->>'score')::float)::text AS avg_score,
             COUNT(*)::text AS feedback_count
           FROM memory_feedback
           WHERE uid = $1 AND value->>'entryId' IS NOT NULL
           GROUP BY value->>'tier', value->>'entryId'
           HAVING AVG((value->>'score')::float) <= -1 AND COUNT(*) >= 3`,
          [ctx.uid],
        );

        let pruned = 0;
        const actions: string[] = [];

        for (const target of pruneTargets) {
          if (target.tier === "graph" && target.entry_id) {
            // Try to delete low-value graph entity
            const { rowCount } = await pool.query(
              `DELETE FROM graph_entities WHERE id = $1::uuid AND uid = $2 AND reinforcement_score < 0.3`,
              [target.entry_id, ctx.uid],
            );
            if (rowCount && rowCount > 0) {
              pruned++;
              actions.push(`Pruned graph entity ${target.entry_id.slice(0, 8)} (avg score: ${target.avg_score})`);
            }
          }
        }

        return {
          result: `Auto-prune complete: ${pruned} entries removed`,
          candidates: pruneTargets.length,
          pruned,
          actions,
        };
      }

      case "weights": {
        if (params.weights) {
          // Set custom RRF weights
          const defaults = { daily: 0.5, profile: 0.7, graph: 0.6, session: 0.4 };
          const merged = { ...defaults, ...params.weights };

          await pool.query(
            `INSERT INTO memory_rrf_weights (uid, weights, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (uid) DO UPDATE SET weights = $2::jsonb, updated_at = NOW()`,
            [ctx.uid, JSON.stringify(merged)],
          );

          return { result: "RRF weights updated", weights: merged };
        }

        // Get current weights
        const { rows } = await pool.query<{ weights: Record<string, number> }>(
          "SELECT weights FROM memory_rrf_weights WHERE uid = $1",
          [ctx.uid],
        );

        const weights = rows.length > 0
          ? rows[0]!.weights
          : { daily: 0.5, profile: 0.7, graph: 0.6, session: 0.4 };

        return { result: "Current RRF weights", weights };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});
