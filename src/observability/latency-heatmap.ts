import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Latency Heatmap ──────────────────────────────────────────────────
// Aggregates agent response latency by hour-of-day and day-of-week.
// Returns a 7×24 matrix of p50/p95 latencies for heatmap visualization.
// Rows = days of week (0=Sun … 6=Sat), Columns = hours (0–23).

const log = createLogger("latency-heatmap");

export type HeatmapMetric = "p50" | "p95";

export interface HeatmapData {
  matrix: number[][];
  labels: {
    hours: string[];
    days: string[];
  };
  metric: HeatmapMetric;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOURS = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, "0")}:00`);

interface HeatmapRow {
  dow: string;  // 0-6 as string from Postgres EXTRACT
  hour: string; // 0-23 as string from Postgres EXTRACT
  p50: string | null;
  p95: string | null;
}

/**
 * Build a 7×24 latency heatmap for a workspace.
 *
 * @param workspaceId - The workspace to query
 * @param agentId     - Optional: restrict to a specific agent
 * @param days        - Lookback window in days (default: 30)
 * @param metric      - p50 or p95 (default: p50)
 */
export async function getLatencyHeatmap(
  workspaceId: string,
  agentId?: string,
  days = 30,
  metric: HeatmapMetric = "p50",
): Promise<HeatmapData> {
  const pool = getPool();

  // Initialize a 7×24 matrix with zeros
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0) as number[]);

  const conditions: string[] = ["workspace_id = $1", "duration_ms IS NOT NULL", "started_at >= NOW() - INTERVAL '1 day' * $2"];
  const values: unknown[] = [workspaceId, days];
  let paramIdx = 3;

  if (agentId) {
    conditions.push(`agent_id = $${paramIdx++}`);
    values.push(agentId);
  }

  const where = conditions.join(" AND ");

  try {
    const { rows } = await pool.query<HeatmapRow>(
      `SELECT
         EXTRACT(DOW FROM started_at AT TIME ZONE 'UTC')::int AS dow,
         EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')::int AS hour,
         PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95
       FROM agent_traces
       WHERE ${where}
       GROUP BY
         EXTRACT(DOW FROM started_at AT TIME ZONE 'UTC'),
         EXTRACT(HOUR FROM started_at AT TIME ZONE 'UTC')
       ORDER BY dow, hour`,
      values,
    );

    for (const row of rows) {
      const dayIndex = Number(row.dow);
      const hourIndex = Number(row.hour);

      if (dayIndex < 0 || dayIndex > 6 || hourIndex < 0 || hourIndex > 23) continue;

      const value = metric === "p95" ? Number(row.p95 ?? 0) : Number(row.p50 ?? 0);
      matrix[dayIndex]![hourIndex] = Math.round(value);
    }
  } catch (err) {
    log.error(`Failed to compute latency heatmap for workspace ${workspaceId}:`, err);
  }

  return {
    matrix,
    labels: {
      hours: HOURS,
      days: DAYS,
    },
    metric,
  };
}
