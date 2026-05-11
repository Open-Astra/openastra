import { z } from "zod";
import { randomUUID } from "node:crypto";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── contextual_boost ───────────────────────────────────────────────
// Memory Retrieval "Contextual Boosting" for RRF. During search, boosts
// scores for memory items based on the active context — current swarm
// phase, debate round, task type, and recently accessed tiers. For
// example, if the agent is in a sequential task, Procedural memory is
// boosted; during debate, contradicting positions are surfaced higher.
//
// Boost profiles can be configured globally or per-swarm via astra.yml
// overrides stored in Postgres.

const ContextualBoostParams = z.object({
  action: z
    .enum(["search", "configure", "profiles", "evaluate", "reset"])
    .describe(
      "Action: boosted search with contextual scoring, configure boost profiles, " +
      "list available profiles, evaluate boost effectiveness, or reset to defaults",
    ),
  query: z
    .string()
    .optional()
    .describe("Search query (for search action)"),
  context: z
    .object({
      task_type: z
        .enum(["research", "analysis", "sequential", "creative", "debugging", "review", "general"])
        .optional()
        .describe("Current task type — determines tier bias"),
      swarm_phase: z
        .enum(["planning", "executing", "mediating", "synthesizing"])
        .optional()
        .describe("Current swarm phase"),
      debate_round: z
        .number()
        .int()
        .optional()
        .describe("Current debate round number (higher rounds → more granular retrieval)"),
      recent_tiers: z
        .array(z.enum(["daily", "profile", "graph", "session", "procedural"]))
        .optional()
        .describe("Recently accessed tiers (these get a recency boost)"),
      swarm_id: z
        .string()
        .optional()
        .describe("Swarm ID for swarm-specific boost overrides"),
    })
    .optional()
    .describe("Context for dynamic boost calculation (for search action)"),
  tier: z
    .enum(["daily", "profile", "graph", "session", "procedural", "all"])
    .default("all")
    .describe("Which tier(s) to search"),
  profile_name: z
    .string()
    .optional()
    .describe("Named boost profile to use or configure"),
  boosts: z
    .object({
      daily: z.number().optional(),
      profile: z.number().optional(),
      graph: z.number().optional(),
      session: z.number().optional(),
      procedural: z.number().optional(),
    })
    .optional()
    .describe("Custom boost multipliers per tier (for configure action)"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
});

// ── Default boost profiles ──────────────────────────────────────────
const DEFAULT_PROFILES: Record<string, Record<string, number>> = {
  research: { daily: 0.6, profile: 0.8, graph: 1.2, session: 0.5, procedural: 0.4 },
  analysis: { daily: 0.5, profile: 0.9, graph: 1.3, session: 0.4, procedural: 0.6 },
  sequential: { daily: 0.4, profile: 0.6, graph: 0.8, session: 0.5, procedural: 1.5 },
  creative: { daily: 0.8, profile: 1.0, graph: 1.1, session: 0.7, procedural: 0.3 },
  debugging: { daily: 1.2, profile: 0.5, graph: 0.9, session: 1.3, procedural: 1.0 },
  review: { daily: 0.7, profile: 0.8, graph: 1.0, session: 0.6, procedural: 0.5 },
  general: { daily: 0.7, profile: 0.8, graph: 1.0, session: 0.6, procedural: 0.5 },
};

// Swarm phase modifiers (applied on top of task-type boosts)
const PHASE_MODIFIERS: Record<string, Record<string, number>> = {
  planning: { daily: 1.0, profile: 1.2, graph: 1.3, session: 0.8, procedural: 0.7 },
  executing: { daily: 0.8, profile: 0.7, graph: 1.0, session: 1.2, procedural: 1.3 },
  mediating: { daily: 0.9, profile: 1.0, graph: 1.2, session: 0.8, procedural: 0.6 },
  synthesizing: { daily: 1.1, profile: 1.0, graph: 0.9, session: 1.1, procedural: 0.5 },
};

registerTool({
  name: "contextual_boost",
  description:
    "Memory Retrieval Contextual Boosting for RRF. Dynamically adjusts per-tier " +
    "retrieval weights based on current context — task type, swarm phase, debate round, " +
    "and recently accessed tiers. Configurable boost profiles per swarm via stored config. " +
    "Results include boosted scores for transparent ranking.",
  parameters: ContextualBoostParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      // ── Search: context-boosted multi-tier search ──────────────
      case "search": {
        if (!params.query) return { error: "query required for search" };

        // Calculate effective boost multipliers
        const context = params.context ?? {};
        const taskType = context.task_type ?? "general";

        // Start with base profile for the task type
        let baseBoosts = { ...DEFAULT_PROFILES[taskType]! };

        // Check for custom profile override
        if (params.profile_name) {
          const { rows: customRows } = await pool.query<{ value: Record<string, number> }>(
            `SELECT value FROM contextual_boost_profiles
             WHERE uid = $1 AND name = $2 LIMIT 1`,
            [ctx.uid, params.profile_name],
          );
          if (customRows.length > 0) {
            baseBoosts = { ...baseBoosts, ...customRows[0]!.value };
          }
        }

        // Check for swarm-specific overrides
        if (context.swarm_id) {
          const { rows: swarmRows } = await pool.query<{ value: Record<string, number> }>(
            `SELECT value FROM contextual_boost_profiles
             WHERE uid = $1 AND name = $2 LIMIT 1`,
            [ctx.uid, `swarm:${context.swarm_id}`],
          );
          if (swarmRows.length > 0) {
            baseBoosts = { ...baseBoosts, ...swarmRows[0]!.value };
          }
        }

        // Apply swarm phase modifier
        if (context.swarm_phase) {
          const phaseModifier = PHASE_MODIFIERS[context.swarm_phase]!;
          for (const tier of Object.keys(baseBoosts)) {
            baseBoosts[tier] = (baseBoosts[tier] ?? 1) * (phaseModifier[tier] ?? 1);
          }
        }

        // Debate round modifier: later rounds boost graph (more specific facts)
        if (context.debate_round && context.debate_round > 1) {
          const roundFactor = Math.min(1.5, 1 + (context.debate_round - 1) * 0.1);
          baseBoosts["graph"] = (baseBoosts["graph"] ?? 1) * roundFactor;
          // Reduce session noise in later rounds
          baseBoosts["session"] = (baseBoosts["session"] ?? 1) * (1 / roundFactor);
        }

        // Recency boost: recently accessed tiers get a small bump
        if (context.recent_tiers && context.recent_tiers.length > 0) {
          for (const tier of context.recent_tiers) {
            baseBoosts[tier] = (baseBoosts[tier] ?? 1) * 1.1;
          }
        }

        // Round boost values
        const finalBoosts: Record<string, number> = {};
        for (const [tier, boost] of Object.entries(baseBoosts)) {
          finalBoosts[tier] = Math.round(boost * 1000) / 1000;
        }

        // Execute multi-tier search with boosts applied
        const allResults: Array<{
          tier: string;
          id: string;
          content: string;
          rawScore: number;
          boostedScore: number;
          boostMultiplier: number;
        }> = [];

        const tiersToSearch = params.tier === "all"
          ? ["daily", "profile", "graph", "session"]
          : [params.tier];

        // Generate embedding for vector search
        let queryEmbedding: number[] | null = null;
        try {
          const { generateEmbedding } = await import("../memory/embeddings.js");
          queryEmbedding = await generateEmbedding(params.query);
        } catch {
          // Proceed with text search only
        }

        for (const tier of tiersToSearch) {
          const boost = finalBoosts[tier] ?? 1;
          const tierResults = await searchTier(pool, ctx.uid, tier, params.query, queryEmbedding, params.limit);

          for (const result of tierResults) {
            allResults.push({
              tier,
              id: result.id,
              content: result.content,
              rawScore: result.score,
              boostedScore: Math.round(result.score * boost * 1000) / 1000,
              boostMultiplier: boost,
            });
          }
        }

        // Sort by boosted score and limit
        allResults.sort((a, b) => b.boostedScore - a.boostedScore);
        const topResults = allResults.slice(0, params.limit);

        // Record which tiers were most useful (for feedback loop)
        const tierDistribution: Record<string, number> = {};
        for (const r of topResults) {
          tierDistribution[r.tier] = (tierDistribution[r.tier] ?? 0) + 1;
        }

        return {
          result: `${topResults.length} result(s) with contextual boosting`,
          context: {
            taskType,
            swarmPhase: context.swarm_phase ?? "none",
            debateRound: context.debate_round ?? 0,
          },
          boosts: finalBoosts,
          results: topResults,
          tierDistribution,
        };
      }

      // ── Configure: set custom boost profiles ───────────────────
      case "configure": {
        const profileName = params.profile_name ?? "custom";
        const boosts = params.boosts ?? {};

        // Merge with defaults
        const base = DEFAULT_PROFILES["general"]!;
        const merged = { ...base, ...boosts };

        await pool.query(
          `INSERT INTO contextual_boost_profiles (id, uid, name, value, updated_at)
           VALUES ($1, $2, $3, $4::jsonb, NOW())
           ON CONFLICT (uid, name) DO UPDATE SET value = $4::jsonb, updated_at = NOW()`,
          [randomUUID(), ctx.uid, profileName, JSON.stringify(merged)],
        );

        return {
          result: "Boost profile configured",
          profileName,
          boosts: merged,
        };
      }

      // ── Profiles: list available boost profiles ────────────────
      case "profiles": {
        // Built-in profiles
        const builtIn = Object.entries(DEFAULT_PROFILES).map(([name, boosts]) => ({
          name,
          type: "built-in",
          boosts,
        }));

        // Custom profiles
        const { rows: customRows } = await pool.query<{
          name: string;
          value: Record<string, number>;
        }>(
          "SELECT name, value FROM contextual_boost_profiles WHERE uid = $1",
          [ctx.uid],
        );

        const custom = customRows.map((r) => ({
          name: r.name,
          type: "custom",
          boosts: r.value,
        }));

        return {
          result: `${builtIn.length} built-in + ${custom.length} custom profile(s)`,
          builtIn,
          custom,
        };
      }

      // ── Evaluate: measure boost effectiveness ──────────────────
      case "evaluate": {
        // Check if memory_feedback data exists to evaluate
        const { rows: feedbackStats } = await pool.query<{
          tier: string;
          avg_score: string;
          count: string;
        }>(
          `SELECT
             value->>'tier' AS tier,
             AVG((value->>'score')::float)::text AS avg_score,
             COUNT(*)::text AS count
           FROM memory_feedback WHERE uid = $1
           GROUP BY value->>'tier'`,
          [ctx.uid],
        );

        if (feedbackStats.length === 0) {
          return {
            result: "No feedback data yet",
            hint: "Use memory_feedback tool to rate retrieved memories, then re-evaluate",
          };
        }

        // Compare feedback-implied weights vs current boosts
        const currentBoosts = DEFAULT_PROFILES["general"]!;
        const feedbackImplied: Record<string, number> = {};
        for (const stat of feedbackStats) {
          const avg = parseFloat(stat.avg_score);
          // Map avg score (-2 to 2) → boost multiplier (0.2 to 1.5)
          feedbackImplied[stat.tier] = Math.max(0.2, Math.min(1.5, 0.7 + avg * 0.3));
        }

        // Calculate divergence
        const divergences: Array<{ tier: string; current: number; suggested: number; delta: number }> = [];
        for (const [tier, suggested] of Object.entries(feedbackImplied)) {
          const current = currentBoosts[tier] ?? 0.5;
          divergences.push({
            tier,
            current: Math.round(current * 100) / 100,
            suggested: Math.round(suggested * 100) / 100,
            delta: Math.round((suggested - current) * 100) / 100,
          });
        }

        return {
          result: "Boost effectiveness evaluation",
          feedbackSummary: feedbackStats.map((r) => ({
            tier: r.tier,
            avgScore: Math.round(parseFloat(r.avg_score) * 100) / 100,
            feedbackCount: parseInt(r.count),
          })),
          divergences,
          recommendation: divergences.some((d) => Math.abs(d.delta) > 0.2)
            ? "Significant divergence detected — consider updating boost profiles with suggested values"
            : "Current boosts are well-aligned with feedback data",
        };
      }

      // ── Reset: clear custom profiles ───────────────────────────
      case "reset": {
        const { rowCount } = await pool.query(
          "DELETE FROM contextual_boost_profiles WHERE uid = $1",
          [ctx.uid],
        );

        return {
          result: "Boost profiles reset to defaults",
          removedProfiles: rowCount ?? 0,
          defaults: DEFAULT_PROFILES["general"],
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

// ── Tier-specific search helpers ─────────────────────────────────────

async function searchTier(
  pool: ReturnType<typeof getPool>,
  uid: string,
  tier: string,
  query: string,
  queryEmbedding: number[] | null,
  limit: number,
): Promise<Array<{ id: string; content: string; score: number }>> {
  switch (tier) {
    case "daily": {
      // Search daily memory entries
      const { rows } = await pool.query<{
        date: string;
        entries: Array<{ content: string; type?: string }>;
      }>(
        "SELECT date, entries FROM daily_memory WHERE user_id = $1 ORDER BY date DESC LIMIT 7",
        [uid],
      );

      const results: Array<{ id: string; content: string; score: number }> = [];
      const queryLower = query.toLowerCase();

      for (const row of rows) {
        for (const entry of row.entries) {
          const content = entry.content ?? "";
          if (content.toLowerCase().includes(queryLower)) {
            results.push({
              id: `daily:${row.date}`,
              content: content.slice(0, 500),
              score: 0.6 + (content.toLowerCase().split(queryLower).length - 1) * 0.1,
            });
          }
        }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    case "profile": {
      const { rows } = await pool.query<{ profile_data: Record<string, unknown> }>(
        "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
        [uid],
      );

      if (rows.length === 0) return [];

      const profile = rows[0]!.profile_data;
      const notes = (profile.strategicNotes as string[]) ?? [];
      const queryLower = query.toLowerCase();

      return notes
        .filter((n) => n.toLowerCase().includes(queryLower))
        .map((n, i) => ({
          id: `profile:note-${i}`,
          content: n,
          score: 0.7,
        }))
        .slice(0, limit);
    }

    case "graph": {
      // Vector search if embedding available, otherwise text
      if (queryEmbedding) {
        const { rows } = await pool.query<{
          id: string;
          name: string;
          summary: string;
          score: number;
        }>(
          `SELECT id, name, summary,
                  1 - (embedding <=> $1::vector) AS score
           FROM graph_entities
           WHERE uid = $2 AND embedding IS NOT NULL
           ORDER BY embedding <=> $1::vector ASC
           LIMIT $3`,
          [JSON.stringify(queryEmbedding), uid, limit],
        );

        return rows.map((r) => ({
          id: `graph:${r.id}`,
          content: `${r.name}: ${r.summary}`,
          score: Math.round(r.score * 1000) / 1000,
        }));
      }

      // Text fallback
      const { rows } = await pool.query<{
        id: string;
        name: string;
        summary: string;
      }>(
        `SELECT id, name, summary FROM graph_entities
         WHERE uid = $1 AND (name ILIKE $2 OR summary ILIKE $2)
         LIMIT $3`,
        [uid, `%${query}%`, limit],
      );

      return rows.map((r) => ({
        id: `graph:${r.id}`,
        content: `${r.name}: ${r.summary}`,
        score: 0.5,
      }));
    }

    case "session": {
      // Search recent session messages
      const { rows } = await pool.query<{
        id: string;
        content: string;
      }>(
        `SELECT id, content FROM session_messages
         WHERE user_id = $1 AND content ILIKE $2
         ORDER BY created_at DESC LIMIT $3`,
        [uid, `%${query}%`, limit],
      );

      return rows.map((r) => ({
        id: `session:${r.id}`,
        content: r.content.slice(0, 500),
        score: 0.5,
      }));
    }

    default:
      return [];
  }
}
