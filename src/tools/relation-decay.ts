import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── relation_decay ──────────────────────────────────────────────────
// Knowledge graph relation strength decay. Edges lose weight over time
// unless reinforced. Agents can scan for weak relations, re-verify
// them, and update via debate. Configurable half-life per edge type.

const RelationDecayParams = z.object({
  action: z
    .enum(["scan_weak", "apply_decay", "reinforce", "configure", "status"])
    .describe("Action: scan for weak relations, apply time-based decay, reinforce an edge, configure decay rates, or check status"),
  edge_id: z.string().optional().describe("Edge ID to reinforce (for reinforce action)"),
  min_weight: z.number().default(0.2).describe("Threshold below which relations are flagged as weak"),
  decay_config: z
    .object({
      half_life_days: z.number().optional().describe("Days until edge weight halves (default: 30)"),
      min_weight: z.number().optional().describe("Floor weight — edges won't decay below this"),
      exempt_types: z.array(z.string()).optional().describe("Edge types exempt from decay"),
    })
    .optional()
    .describe("Decay configuration (for configure action)"),
  dry_run: z.boolean().default(false).describe("Preview decay effects without applying"),
});

registerTool({
  name: "relation_decay",
  description:
    "Knowledge graph relation strength decay. Manage time-based edge weight decay, scan for weak relations needing re-verification, and reinforce confirmed relationships.",
  parameters: RelationDecayParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "scan_weak": {
        const { rows } = await pool.query<{
          id: string;
          source_name: string;
          target_name: string;
          type: string;
          weight: number;
          days_since_reinforced: string;
          reinforcement_count: number;
        }>(
          `SELECT
             e.id,
             s.name AS source_name,
             t.name AS target_name,
             e.type,
             e.weight,
             EXTRACT(DAY FROM NOW() - e.last_reinforced_at)::text AS days_since_reinforced,
             e.reinforcement_count
           FROM graph_edges e
           JOIN graph_entities s ON s.id = e.source_id AND s.uid = $1
           JOIN graph_entities t ON t.id = e.target_id AND t.uid = $1
           WHERE e.uid = $1 AND e.weight < $2
           ORDER BY e.weight ASC LIMIT 20`,
          [ctx.uid, params.min_weight],
        );

        return {
          result: `${rows.length} weak relation(s) found (weight < ${params.min_weight})`,
          weakRelations: rows.map((r) => ({
            edgeId: r.id,
            source: r.source_name,
            target: r.target_name,
            type: r.type,
            weight: r.weight,
            daysSinceReinforced: parseInt(r.days_since_reinforced),
            reinforcementCount: r.reinforcement_count,
            recommendation: r.weight < 0.1 ? "Consider pruning" : "Needs re-verification",
          })),
        };
      }

      case "apply_decay": {
        // Get decay config
        const config = await getDecayConfig(pool, ctx.uid);
        const halfLifeMs = config.half_life_days * 24 * 60 * 60 * 1000;

        // Calculate decay factor for each edge based on time since last reinforcement
        const { rows: edges } = await pool.query<{
          id: string;
          type: string;
          weight: number;
          ms_since_reinforced: string;
        }>(
          `SELECT
             id, type, weight,
             EXTRACT(EPOCH FROM NOW() - last_reinforced_at)::bigint * 1000 AS ms_since_reinforced
           FROM graph_edges WHERE uid = $1`,
          [ctx.uid],
        );

        let decayed = 0;
        let skipped = 0;

        for (const edge of edges) {
          // Skip exempt types
          if (config.exempt_types.includes(edge.type)) {
            skipped++;
            continue;
          }

          const elapsed = parseInt(edge.ms_since_reinforced);
          const decayFactor = Math.pow(0.5, elapsed / halfLifeMs);
          const newWeight = Math.max(config.min_weight, edge.weight * decayFactor);

          if (Math.abs(newWeight - edge.weight) > 0.01) {
            if (!params.dry_run) {
              await pool.query(
                "UPDATE graph_edges SET weight = $1 WHERE id = $2::uuid AND uid = $3",
                [newWeight, edge.id, ctx.uid],
              );
            }
            decayed++;
          }
        }

        return {
          result: params.dry_run ? "Decay preview" : "Decay applied",
          dryRun: params.dry_run,
          totalEdges: edges.length,
          decayed,
          skipped,
          config: {
            halfLifeDays: config.half_life_days,
            minWeight: config.min_weight,
            exemptTypes: config.exempt_types,
          },
        };
      }

      case "reinforce": {
        if (!params.edge_id) return { error: "edge_id required for reinforce" };

        const { rowCount } = await pool.query(
          `UPDATE graph_edges
           SET weight = LEAST(1.0, weight + 0.15),
               last_reinforced_at = NOW(),
               reinforcement_count = reinforcement_count + 1
           WHERE id = $1::uuid AND uid = $2`,
          [params.edge_id, ctx.uid],
        );

        if (rowCount === 0) return { error: "Edge not found" };

        // Get updated edge info
        const { rows } = await pool.query<{
          weight: number;
          reinforcement_count: number;
          source_name: string;
          target_name: string;
          type: string;
        }>(
          `SELECT e.weight, e.reinforcement_count, s.name AS source_name, t.name AS target_name, e.type
           FROM graph_edges e
           JOIN graph_entities s ON s.id = e.source_id
           JOIN graph_entities t ON t.id = e.target_id
           WHERE e.id = $1::uuid AND e.uid = $2`,
          [params.edge_id, ctx.uid],
        );

        const edge = rows[0]!;
        return {
          result: "Relation reinforced",
          edgeId: params.edge_id,
          relation: `${edge.source_name} → ${edge.target_name} (${edge.type})`,
          newWeight: edge.weight,
          reinforcementCount: edge.reinforcement_count,
        };
      }

      case "configure": {
        if (!params.decay_config) return { error: "decay_config required" };

        const defaults = { half_life_days: 30, min_weight: 0.05, exempt_types: ["user_noted"] };
        const merged = { ...defaults, ...params.decay_config };

        await pool.query(
          `INSERT INTO relation_decay_config (uid, config, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (uid) DO UPDATE SET config = $2::jsonb, updated_at = NOW()`,
          [ctx.uid, JSON.stringify(merged)],
        );

        return { result: "Decay configuration updated", config: merged };
      }

      case "status": {
        const config = await getDecayConfig(pool, ctx.uid);

        const { rows: stats } = await pool.query<{
          total: string;
          weak: string;
          strong: string;
          avg_weight: string;
          avg_age_days: string;
        }>(
          `SELECT
             COUNT(*)::text AS total,
             COUNT(*) FILTER (WHERE weight < 0.2)::text AS weak,
             COUNT(*) FILTER (WHERE weight >= 0.7)::text AS strong,
             AVG(weight)::text AS avg_weight,
             AVG(EXTRACT(DAY FROM NOW() - last_reinforced_at))::text AS avg_age_days
           FROM graph_edges WHERE uid = $1`,
          [ctx.uid],
        );

        return {
          result: "Decay status",
          config,
          stats: {
            totalEdges: parseInt(stats[0]?.total ?? "0"),
            weakEdges: parseInt(stats[0]?.weak ?? "0"),
            strongEdges: parseInt(stats[0]?.strong ?? "0"),
            avgWeight: Math.round(parseFloat(stats[0]?.avg_weight ?? "0") * 100) / 100,
            avgAgeDays: Math.round(parseFloat(stats[0]?.avg_age_days ?? "0")),
          },
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

interface DecayConfig {
  half_life_days: number;
  min_weight: number;
  exempt_types: string[];
}

async function getDecayConfig(pool: ReturnType<typeof getPool>, uid: string): Promise<DecayConfig> {
  const { rows } = await pool.query<{ config: DecayConfig }>(
    "SELECT config FROM relation_decay_config WHERE uid = $1",
    [uid],
  );
  return rows.length > 0 ? rows[0]!.config : { half_life_days: 30, min_weight: 0.05, exempt_types: ["user_noted"] };
}
