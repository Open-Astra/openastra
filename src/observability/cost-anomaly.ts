import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

// ── Cost Anomaly Detection ────────────────────────────────────────────
// Detects cost anomalies by comparing the current hour's cost against
// the rolling 7-day hourly average. An anomaly is flagged when the
// current hour cost exceeds 3× the rolling average.

const log = createLogger("cost-anomaly");

const ANOMALY_MULTIPLIER = 3;

export interface AnomalyResult {
  workspaceId: string;
  currentHourCost: number;
  avgHourCost: number;
  multiplier: number;
}

/**
 * Detect cost anomalies for a specific workspace.
 * Queries billing_usage to compute hourly token costs and compares
 * the current hour against the rolling 7-day average.
 */
export async function detectCostAnomalies(workspaceId: string): Promise<AnomalyResult[]> {
  const pool = getPool();

  // We proxy token counts as a cost measure since billing_usage stores
  // aggregated monthly data. For hourly granularity we use agent_traces
  // which has started_at timestamps and token fields.
  let rows: Array<{
    workspace_id: string;
    hour_bucket: string;
    hourly_tokens: string;
  }>;

  try {
    const result = await pool.query<{
      workspace_id: string;
      hour_bucket: string;
      hourly_tokens: string;
    }>(
      `SELECT
         workspace_id,
         DATE_TRUNC('hour', started_at) AS hour_bucket,
         SUM(total_tokens) AS hourly_tokens
       FROM agent_traces
       WHERE workspace_id = $1
         AND started_at >= NOW() - INTERVAL '7 days'
       GROUP BY workspace_id, DATE_TRUNC('hour', started_at)
       ORDER BY hour_bucket DESC`,
      [workspaceId],
    );
    rows = result.rows;
  } catch (err) {
    log.error(`Failed to query agent_traces for workspace ${workspaceId}:`, err);
    return [];
  }

  if (rows.length === 0) return [];

  // Most recent hour bucket
  const currentBucket = rows[0]?.hour_bucket;
  if (!currentBucket) return [];

  const currentHourRow = rows.find((r) => r.hour_bucket === currentBucket);
  const currentHourCost = Number(currentHourRow?.hourly_tokens ?? 0);

  // Historical rows (all except current hour) for the rolling average
  const historicalRows = rows.filter((r) => r.hour_bucket !== currentBucket);
  if (historicalRows.length === 0) return [];

  const totalHistorical = historicalRows.reduce((sum, r) => sum + Number(r.hourly_tokens), 0);
  const avgHourCost = totalHistorical / historicalRows.length;

  if (avgHourCost <= 0) return [];

  const multiplier = currentHourCost / avgHourCost;

  if (multiplier < ANOMALY_MULTIPLIER) return [];

  const anomaly: AnomalyResult = {
    workspaceId,
    currentHourCost,
    avgHourCost,
    multiplier,
  };

  // Emit cost.anomaly event
  try {
    const bus = getEventBus();
    // Use cost.threshold event (existing schema) as the closest match for anomalies
    bus.emit("cost.threshold", {
      workspaceId,
      currentCost: currentHourCost,
      threshold: avgHourCost * ANOMALY_MULTIPLIER,
      period: "hourly-anomaly",
      timestamp: Date.now(),
    });
  } catch (err) {
    log.error("Failed to emit cost anomaly event:", err);
  }

  log.warn(
    `Cost anomaly detected: workspace=${workspaceId} ` +
    `currentHour=${currentHourCost} avg=${avgHourCost.toFixed(2)} ` +
    `multiplier=${multiplier.toFixed(2)}x`,
  );

  return [anomaly];
}

/**
 * Run cost anomaly detection across all workspaces.
 * Called by the hourly cron job.
 */
export async function detectCostAnomaliesAllWorkspaces(): Promise<void> {
  const pool = getPool();

  let workspaceIds: string[];
  try {
    const { rows } = await pool.query<{ workspace_id: string }>(
      `SELECT DISTINCT workspace_id FROM agent_traces
       WHERE workspace_id IS NOT NULL
         AND started_at >= NOW() - INTERVAL '7 days'`,
    );
    workspaceIds = rows.map((r) => r.workspace_id);
  } catch (err) {
    log.error("Failed to fetch workspaces for anomaly detection:", err);
    return;
  }

  let anomalyCount = 0;
  for (const workspaceId of workspaceIds) {
    const anomalies = await detectCostAnomalies(workspaceId).catch((err: unknown) => {
      log.error(`Anomaly detection failed for workspace ${workspaceId}:`, err);
      return [] as AnomalyResult[];
    });
    anomalyCount += anomalies.length;
  }

  if (anomalyCount > 0) {
    log.warn(`Cost anomaly scan complete: ${anomalyCount} anomalies across ${workspaceIds.length} workspaces`);
  } else {
    log.dim(`Cost anomaly scan complete: no anomalies (${workspaceIds.length} workspaces checked)`);
  }
}
