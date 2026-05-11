import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── memory_propagate ────────────────────────────────────────────────
// Hierarchical memory propagation with configurable auto-promotion
// thresholds. Promotes high-value entries from lower tiers to higher
// ones (daily → profile, daily → graph) when access patterns or
// reinforcement scores exceed thresholds.

const MemoryPropagateParams = z.object({
  action: z
    .enum(["propagate", "configure", "preview", "status"])
    .describe("Action: run propagation, configure thresholds, preview candidates, or check propagation status"),
  direction: z
    .enum(["daily_to_profile", "daily_to_graph", "graph_to_profile", "all"])
    .default("all")
    .describe("Propagation direction"),
  thresholds: z
    .object({
      min_mentions: z.number().optional().describe("Minimum times a concept appears before promotion"),
      min_reinforcement: z.number().optional().describe("Minimum reinforcement score for graph → profile"),
      max_age_days: z.number().optional().describe("Only promote entries newer than this many days"),
    })
    .optional()
    .describe("Custom promotion thresholds (for configure action)"),
  dry_run: z.boolean().default(false).describe("Preview what would be propagated without applying"),
});

registerTool({
  name: "memory_propagate",
  description:
    "Hierarchical memory propagation across tiers. Automatically promote high-value daily entries to profile notes, extract entities to graph, and surface graph patterns to profile. Configurable thresholds.",
  parameters: MemoryPropagateParams,

  async execute(params, ctx) {
    const pool = getPool();

    switch (params.action) {
      case "propagate":
      case "preview": {
        const isDryRun = params.dry_run || params.action === "preview";
        const thresholds = await getThresholds(pool, ctx.uid);
        const directions = params.direction === "all"
          ? ["daily_to_profile", "daily_to_graph", "graph_to_profile"]
          : [params.direction];

        const results: PropagationResult[] = [];

        for (const dir of directions) {
          switch (dir) {
            case "daily_to_profile":
              results.push(await propagateDailyToProfile(pool, ctx.uid, thresholds, isDryRun));
              break;
            case "daily_to_graph":
              results.push(await propagateDailyToGraph(pool, ctx.uid, thresholds, isDryRun));
              break;
            case "graph_to_profile":
              results.push(await propagateGraphToProfile(pool, ctx.uid, thresholds, isDryRun));
              break;
          }
        }

        return {
          result: isDryRun ? "Propagation preview" : "Propagation complete",
          dryRun: isDryRun,
          propagations: results,
          totalPromoted: results.reduce((sum, r) => sum + r.promoted, 0),
        };
      }

      case "configure": {
        if (!params.thresholds) return { error: "thresholds required for configure" };

        const defaults = { min_mentions: 3, min_reinforcement: 0.5, max_age_days: 30 };
        const merged = { ...defaults, ...params.thresholds };

        await pool.query(
          `INSERT INTO memory_propagation_config (uid, thresholds, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (uid) DO UPDATE SET thresholds = $2::jsonb, updated_at = NOW()`,
          [ctx.uid, JSON.stringify(merged)],
        );

        return { result: "Propagation thresholds configured", thresholds: merged };
      }

      case "status": {
        const thresholds = await getThresholds(pool, ctx.uid);

        // Count candidates per direction
        const dailyToProfileCandidates = await countDailyToProfileCandidates(pool, ctx.uid, thresholds);
        const dailyToGraphCandidates = await countDailyToGraphCandidates(pool, ctx.uid, thresholds);
        const graphToProfileCandidates = await countGraphToProfileCandidates(pool, ctx.uid, thresholds);

        return {
          result: "Propagation status",
          thresholds,
          candidates: {
            daily_to_profile: dailyToProfileCandidates,
            daily_to_graph: dailyToGraphCandidates,
            graph_to_profile: graphToProfileCandidates,
          },
          totalCandidates: dailyToProfileCandidates + dailyToGraphCandidates + graphToProfileCandidates,
        };
      }

      default:
        return { error: "Unknown action" };
    }
  },
});

interface PropagationResult {
  direction: string;
  candidates: number;
  promoted: number;
  details: string[];
}

interface PropagationThresholds {
  min_mentions: number;
  min_reinforcement: number;
  max_age_days: number;
}

async function getThresholds(
  pool: ReturnType<typeof getPool>,
  uid: string,
): Promise<PropagationThresholds> {
  const { rows } = await pool.query<{ thresholds: PropagationThresholds }>(
    "SELECT thresholds FROM memory_propagation_config WHERE uid = $1",
    [uid],
  );
  return rows.length > 0
    ? rows[0]!.thresholds
    : { min_mentions: 3, min_reinforcement: 0.5, max_age_days: 30 };
}

async function propagateDailyToProfile(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: PropagationThresholds,
  dryRun: boolean,
): Promise<PropagationResult> {
  // Find frequently mentioned concepts in recent daily entries
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholds.max_age_days);

  const { rows } = await pool.query<{ entries: Array<{ content: string; category: string }> }>(
    "SELECT entries FROM daily_memory WHERE user_id = $1 AND date >= $2",
    [uid, cutoff.toISOString().split("T")[0]],
  );

  // Count word/phrase frequency across entries
  const wordFreq: Record<string, number> = {};
  const strategicEntries: string[] = [];

  for (const row of rows) {
    for (const entry of row.entries) {
      // Promote decision and strategy entries that appear multiple times
      if (entry.category === "decision" || entry.category === "strategy") {
        const key = entry.content.slice(0, 100);
        wordFreq[key] = (wordFreq[key] ?? 0) + 1;
        if (wordFreq[key]! >= thresholds.min_mentions) {
          strategicEntries.push(entry.content);
        }
      }
    }
  }

  const uniquePromotions = [...new Set(strategicEntries)].slice(0, 10);
  const details: string[] = [];

  if (!dryRun && uniquePromotions.length > 0) {
    // Add to profile strategic notes
    const { rows: profileRows } = await pool.query<{
      profile_data: { strategicNotes: string[] };
    }>(
      "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
      [uid],
    );

    if (profileRows.length > 0) {
      const existing = new Set(profileRows[0]!.profile_data.strategicNotes ?? []);
      const newNotes = uniquePromotions.filter((n) => !existing.has(n));

      if (newNotes.length > 0) {
        const merged = [...(profileRows[0]!.profile_data.strategicNotes ?? []), ...newNotes];
        await pool.query(
          `UPDATE memory_profiles
           SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb), updated_at = NOW()
           WHERE user_id = $2`,
          [JSON.stringify(merged), uid],
        );
        details.push(...newNotes.map((n) => `Promoted: "${n.slice(0, 80)}"`));
      }
    }
  } else {
    details.push(...uniquePromotions.map((n) => `Would promote: "${n.slice(0, 80)}"`));
  }

  return {
    direction: "daily_to_profile",
    candidates: uniquePromotions.length,
    promoted: dryRun ? 0 : uniquePromotions.length,
    details,
  };
}

async function propagateDailyToGraph(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: PropagationThresholds,
  dryRun: boolean,
): Promise<PropagationResult> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholds.max_age_days);

  const { rows } = await pool.query<{ entries: Array<{ content: string }> }>(
    "SELECT entries FROM daily_memory WHERE user_id = $1 AND date >= $2",
    [uid, cutoff.toISOString().split("T")[0]],
  );

  // Extract potential entities from daily entries
  const entityMentions: Record<string, number> = {};
  const namePattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g;

  for (const row of rows) {
    for (const entry of row.entries) {
      let match;
      while ((match = namePattern.exec(entry.content)) !== null) {
        const name = match[1]!;
        entityMentions[name] = (entityMentions[name] ?? 0) + 1;
      }
    }
  }

  const candidates = Object.entries(entityMentions)
    .filter(([, count]) => count >= thresholds.min_mentions)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const details: string[] = [];

  if (!dryRun && candidates.length > 0) {
    for (const [name, count] of candidates) {
      // Check if entity already exists
      const { rows: existing } = await pool.query<{ id: string }>(
        "SELECT id FROM graph_entities WHERE uid = $1 AND name = $2 LIMIT 1",
        [uid, name],
      );

      if (existing.length === 0) {
        await pool.query(
          `INSERT INTO graph_entities (uid, type, name, description, properties)
           VALUES ($1, 'concept', $2, $3, '{}'::jsonb)`,
          [uid, name, `Auto-extracted from daily memory (${count} mentions)`],
        );
        details.push(`Created entity: "${name}" (${count} mentions)`);
      } else {
        // Reinforce existing entity
        await pool.query(
          `UPDATE graph_entities SET reinforcement_score = reinforcement_score + 0.1, last_accessed_at = NOW()
           WHERE id = $1::uuid AND uid = $2`,
          [existing[0]!.id, uid],
        );
        details.push(`Reinforced entity: "${name}" (${count} mentions)`);
      }
    }
  } else {
    details.push(...candidates.map(([name, count]) => `Would extract: "${name}" (${count} mentions)`));
  }

  return {
    direction: "daily_to_graph",
    candidates: candidates.length,
    promoted: dryRun ? 0 : candidates.length,
    details,
  };
}

async function propagateGraphToProfile(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: PropagationThresholds,
  dryRun: boolean,
): Promise<PropagationResult> {
  // Find high-reinforcement graph entities that warrant profile mention
  const { rows: topEntities } = await pool.query<{
    name: string;
    type: string;
    reinforcement_score: number;
    access_count: number;
  }>(
    `SELECT name, type, reinforcement_score, access_count
     FROM graph_entities WHERE uid = $1 AND reinforcement_score >= $2
     ORDER BY reinforcement_score DESC LIMIT 10`,
    [uid, thresholds.min_reinforcement],
  );

  const details: string[] = [];

  if (!dryRun && topEntities.length > 0) {
    const { rows: profileRows } = await pool.query<{
      profile_data: { interests: string[] };
    }>(
      "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
      [uid],
    );

    if (profileRows.length > 0) {
      const existing = new Set(profileRows[0]!.profile_data.interests ?? []);
      const newInterests = topEntities
        .map((e) => e.name)
        .filter((n) => !existing.has(n));

      if (newInterests.length > 0) {
        const merged = [...(profileRows[0]!.profile_data.interests ?? []), ...newInterests];
        await pool.query(
          `UPDATE memory_profiles
           SET profile_data = jsonb_set(profile_data, '{interests}', $1::jsonb), updated_at = NOW()
           WHERE user_id = $2`,
          [JSON.stringify(merged), uid],
        );
        details.push(...newInterests.map((n) => `Added interest: "${n}"`));
      }
    }
  } else {
    details.push(...topEntities.map((e) => `Would promote: "${e.name}" (score: ${e.reinforcement_score})`));
  }

  return {
    direction: "graph_to_profile",
    candidates: topEntities.length,
    promoted: dryRun ? 0 : topEntities.length,
    details,
  };
}

async function countDailyToProfileCandidates(pool: ReturnType<typeof getPool>, uid: string, _thresholds: PropagationThresholds): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM daily_memory WHERE user_id = $1`,
    [uid],
  );
  return Math.min(10, Math.floor(parseInt(rows[0]?.count ?? "0") / 3));
}

async function countDailyToGraphCandidates(pool: ReturnType<typeof getPool>, uid: string, _thresholds: PropagationThresholds): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM daily_memory WHERE user_id = $1`,
    [uid],
  );
  return Math.min(10, Math.floor(parseInt(rows[0]?.count ?? "0") / 5));
}

async function countGraphToProfileCandidates(pool: ReturnType<typeof getPool>, uid: string, thresholds: PropagationThresholds): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM graph_entities
     WHERE uid = $1 AND reinforcement_score >= $2`,
    [uid, thresholds.min_reinforcement],
  );
  return parseInt(rows[0]?.count ?? "0");
}
