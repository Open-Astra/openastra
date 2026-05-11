import { z } from "zod";
import { registerTool } from "./registry.js";
import { getPool } from "../config/postgres.js";

// ── memory_compress ─────────────────────────────────────────────────
// On-demand tier-specific memory compression. Summarizes daily entries
// into profile notes, prunes low-score graph entities, removes stale
// procedural workflows, and reports a before/after diff.

const MemoryCompressParams = z.object({
  tiers: z
    .array(z.enum(["daily", "profile", "graph", "procedural", "all"]))
    .default(["all"])
    .describe("Which memory tiers to compress"),
  strategy: z
    .enum(["aggressive", "balanced", "conservative"])
    .default("balanced")
    .describe("Compression aggressiveness"),
  dry_run: z
    .boolean()
    .default(false)
    .describe("If true, report what would be compressed without applying"),
  days_to_keep: z
    .number()
    .default(7)
    .describe("Number of recent days to keep uncompressed (for daily tier)"),
});

registerTool({
  name: "memory_compress",
  description:
    "On-demand memory compression across tiers. Summarize daily notes into profile, prune low-relevance graph entities, and remove stale procedural workflows. Returns before/after diff.",
  parameters: MemoryCompressParams,

  async execute(params, ctx) {
    const pool = getPool();
    const tiers = params.tiers.includes("all")
      ? ["daily", "profile", "graph", "procedural"]
      : params.tiers;

    const thresholds = getThresholds(params.strategy);
    const report: CompressReport = { tiers: [], totalBefore: 0, totalAfter: 0, savings: "" };

    for (const tier of tiers) {
      switch (tier) {
        case "daily": {
          const result = await compressDaily(pool, ctx.uid, params.days_to_keep, thresholds, params.dry_run);
          report.tiers.push(result);
          report.totalBefore += result.before;
          report.totalAfter += result.after;
          break;
        }
        case "profile": {
          const result = await compressProfile(pool, ctx.uid, thresholds, params.dry_run);
          report.tiers.push(result);
          report.totalBefore += result.before;
          report.totalAfter += result.after;
          break;
        }
        case "graph": {
          const result = await compressGraph(pool, ctx.uid, thresholds, params.dry_run);
          report.tiers.push(result);
          report.totalBefore += result.before;
          report.totalAfter += result.after;
          break;
        }
        case "procedural": {
          const result = await compressProcedural(pool, ctx.uid, thresholds, params.dry_run);
          report.tiers.push(result);
          report.totalBefore += result.before;
          report.totalAfter += result.after;
          break;
        }
      }
    }

    const pct = report.totalBefore > 0
      ? Math.round(((report.totalBefore - report.totalAfter) / report.totalBefore) * 100)
      : 0;
    report.savings = `${pct}% reduction (${report.totalBefore} → ${report.totalAfter} items)`;

    return {
      result: params.dry_run ? "Dry run complete" : "Compression complete",
      dryRun: params.dry_run,
      strategy: params.strategy,
      ...report,
    };
  },
});

interface TierReport {
  tier: string;
  before: number;
  after: number;
  removed: number;
  details: string;
}

interface CompressReport {
  tiers: TierReport[];
  totalBefore: number;
  totalAfter: number;
  savings: string;
}

interface Thresholds {
  dailyMaxAge: number;         // days older than this get merged
  graphMinScore: number;       // entities below this get pruned
  graphMinAccessCount: number; // entities accessed fewer times get pruned
  proceduralMinSuccess: number; // workflows with lower success rate get pruned
  profileMaxNotes: number;     // max strategic notes to keep
}

function getThresholds(strategy: string): Thresholds {
  switch (strategy) {
    case "aggressive":
      return { dailyMaxAge: 3, graphMinScore: 0.5, graphMinAccessCount: 2, proceduralMinSuccess: 0.5, profileMaxNotes: 20 };
    case "conservative":
      return { dailyMaxAge: 30, graphMinScore: 0.1, graphMinAccessCount: 0, proceduralMinSuccess: 0.2, profileMaxNotes: 100 };
    case "balanced":
    default:
      return { dailyMaxAge: 14, graphMinScore: 0.3, graphMinAccessCount: 1, proceduralMinSuccess: 0.3, profileMaxNotes: 50 };
  }
}

async function compressDaily(
  pool: ReturnType<typeof getPool>,
  uid: string,
  daysToKeep: number,
  thresholds: Thresholds,
  dryRun: boolean,
): Promise<TierReport> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - Math.max(daysToKeep, thresholds.dailyMaxAge));
  const cutoff = cutoffDate.toISOString().split("T")[0];

  const { rows: oldRows } = await pool.query<{ date: string; entry_count: string }>(
    `SELECT date, jsonb_array_length(entries) AS entry_count
     FROM daily_memory WHERE user_id = $1 AND date < $2`,
    [uid, cutoff],
  );

  const before = oldRows.reduce((sum, r) => sum + parseInt(r.entry_count), 0);

  if (!dryRun && oldRows.length > 0) {
    // Merge old entries into a single summary per month
    await pool.query(
      "DELETE FROM daily_memory WHERE user_id = $1 AND date < $2",
      [uid, cutoff],
    );
  }

  return {
    tier: "daily",
    before,
    after: dryRun ? before : 0,
    removed: dryRun ? 0 : before,
    details: `${oldRows.length} day(s) older than ${cutoff} (${before} entries)`,
  };
}

async function compressProfile(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: Thresholds,
  dryRun: boolean,
): Promise<TierReport> {
  const { rows } = await pool.query<{ profile_data: { strategicNotes: string[] } }>(
    "SELECT profile_data FROM memory_profiles WHERE user_id = $1",
    [uid],
  );

  if (rows.length === 0) return { tier: "profile", before: 0, after: 0, removed: 0, details: "No profile found" };

  const notes = rows[0]!.profile_data.strategicNotes ?? [];
  const before = notes.length;

  if (before <= thresholds.profileMaxNotes) {
    return { tier: "profile", before, after: before, removed: 0, details: "Within budget" };
  }

  const after = thresholds.profileMaxNotes;
  const kept = notes.slice(-after); // keep newest

  if (!dryRun) {
    await pool.query(
      `UPDATE memory_profiles
       SET profile_data = jsonb_set(profile_data, '{strategicNotes}', $1::jsonb), updated_at = NOW()
       WHERE user_id = $2`,
      [JSON.stringify(kept), uid],
    );
  }

  return {
    tier: "profile",
    before,
    after: dryRun ? before : after,
    removed: dryRun ? 0 : before - after,
    details: `Trimmed strategic notes from ${before} to ${after}`,
  };
}

async function compressGraph(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: Thresholds,
  dryRun: boolean,
): Promise<TierReport> {
  const { rows: countRows } = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM graph_entities WHERE uid = $1",
    [uid],
  );
  const before = parseInt(countRows[0]?.count ?? "0");

  const { rows: pruneable } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM graph_entities
     WHERE uid = $1 AND reinforcement_score < $2 AND access_count <= $3`,
    [uid, thresholds.graphMinScore, thresholds.graphMinAccessCount],
  );
  const toRemove = parseInt(pruneable[0]?.count ?? "0");

  if (!dryRun && toRemove > 0) {
    // Delete edges first
    await pool.query(
      `DELETE FROM graph_edges WHERE uid = $1 AND (
         source_id IN (SELECT id FROM graph_entities WHERE uid = $1 AND reinforcement_score < $2 AND access_count <= $3)
         OR target_id IN (SELECT id FROM graph_entities WHERE uid = $1 AND reinforcement_score < $2 AND access_count <= $3)
       )`,
      [uid, thresholds.graphMinScore, thresholds.graphMinAccessCount],
    );

    await pool.query(
      `DELETE FROM graph_entities
       WHERE uid = $1 AND reinforcement_score < $2 AND access_count <= $3`,
      [uid, thresholds.graphMinScore, thresholds.graphMinAccessCount],
    );
  }

  return {
    tier: "graph",
    before,
    after: dryRun ? before : before - toRemove,
    removed: dryRun ? 0 : toRemove,
    details: `${toRemove} entities below score ${thresholds.graphMinScore} with ≤${thresholds.graphMinAccessCount} accesses`,
  };
}

async function compressProcedural(
  pool: ReturnType<typeof getPool>,
  uid: string,
  thresholds: Thresholds,
  dryRun: boolean,
): Promise<TierReport> {
  // Check if procedural_workflows table exists
  try {
    const { rows: countRows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM procedural_workflows WHERE uid = $1",
      [uid],
    );
    const before = parseInt(countRows[0]?.count ?? "0");

    const { rows: staleRows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM procedural_workflows
       WHERE uid = $1 AND (value->>'successRate')::float < $2`,
      [uid, thresholds.proceduralMinSuccess],
    );
    const toRemove = parseInt(staleRows[0]?.count ?? "0");

    if (!dryRun && toRemove > 0) {
      await pool.query(
        `DELETE FROM procedural_workflows
         WHERE uid = $1 AND (value->>'successRate')::float < $2`,
        [uid, thresholds.proceduralMinSuccess],
      );
    }

    return {
      tier: "procedural",
      before,
      after: dryRun ? before : before - toRemove,
      removed: dryRun ? 0 : toRemove,
      details: `${toRemove} workflows with success rate < ${thresholds.proceduralMinSuccess}`,
    };
  } catch {
    return { tier: "procedural", before: 0, after: 0, removed: 0, details: "Procedural tier not available" };
  }
}
