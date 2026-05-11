import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

// ── Skill Metrics ────────────────────────────────────────────────────
// Listens for skill.executed events and persists them to skill_metrics.
// Provides query functions for the metrics API endpoint.

const log = createLogger("skill-metrics");

export interface SkillMetricsSummary {
  skillId: string;
  totalCalls: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  topTools: Array<{ toolName: string; calls: number }>;
  topUsers: Array<{ uid: string; calls: number }>;
}

export function startSkillMetricsListener(): () => void {
  const bus = getEventBus();
  return bus.on("skill.executed", async (payload) => {
    try {
      const pool = getPool();
      await pool.query(
        `INSERT INTO skill_metrics (skill_id, uid, tool_name, duration_ms, error)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          payload.skillId,
          payload.uid,
          payload.toolName,
          Math.round(payload.durationMs),
          payload.error ?? null,
        ],
      );
    } catch (err) {
      log.dim(`Skill metrics insert failed: ${err}`);
    }
  });
}

export async function getSkillMetrics(skillId: string): Promise<SkillMetricsSummary> {
  const pool = getPool();

  const { rows } = await pool.query<{
    total: string;
    errors: string;
    p50: string;
    p95: string;
  }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE error IS NOT NULL)::text AS errors,
       PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)::text AS p50,
       PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::text AS p95
     FROM skill_metrics
     WHERE skill_id = $1 AND timestamp > NOW() - INTERVAL '30 days'`,
    [skillId],
  );

  const { rows: toolRows } = await pool.query<{ tool_name: string; calls: string }>(
    `SELECT tool_name, COUNT(*)::text AS calls
     FROM skill_metrics
     WHERE skill_id = $1 AND timestamp > NOW() - INTERVAL '30 days'
     GROUP BY tool_name ORDER BY calls DESC LIMIT 5`,
    [skillId],
  );

  const { rows: userRows } = await pool.query<{ uid: string; calls: string }>(
    `SELECT uid, COUNT(*)::text AS calls
     FROM skill_metrics
     WHERE skill_id = $1 AND timestamp > NOW() - INTERVAL '30 days'
     GROUP BY uid ORDER BY calls DESC LIMIT 5`,
    [skillId],
  );

  const summary = rows[0] ?? { total: "0", errors: "0", p50: "0", p95: "0" };
  const total = parseInt(summary.total, 10);

  return {
    skillId,
    totalCalls: total,
    errorRate: total > 0 ? parseInt(summary.errors, 10) / total : 0,
    p50Ms: parseFloat(summary.p50 ?? "0"),
    p95Ms: parseFloat(summary.p95 ?? "0"),
    topTools: toolRows.map((r) => ({ toolName: r.tool_name, calls: parseInt(r.calls, 10) })),
    topUsers: userRows.map((r) => ({ uid: r.uid, calls: parseInt(r.calls, 10) })),
  };
}
