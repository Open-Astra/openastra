// ── Adaptive Batch Sizing (Feature 7) ────────────────────────────────
// Optimizes batch size based on latency.
// Increases size when latency is low, decreases when high.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("adaptive-batcher");

const LATENCY_THRESHOLD_MS = 2000; // Target latency
const MIN_BATCH_SIZE = 1;
const MAX_BATCH_SIZE = 32;
const WINDOW_SIZE = 10; // Look at last 10 runs

/**
 * Compute optimal batch size based on recent latencies.
 * Uses exponential backoff: if latency high, reduce; if low, increase.
 * @param agentId - Agent identifier
 * @param workspace - Workspace ID
 * @param currentLatency - Current request latency in ms
 * @returns Recommended batch size (1-32)
 */
export async function computeOptimalBatchSize(
  agentId: string,
  workspace: string,
  currentLatency: number,
): Promise<number> {
  try {
    const pool = getPool();

    // Get recent batch metrics
    const result = await pool.query<{
      avg_latency: string;
      max_latency: string;
      error_rate: string;
    }>(
      `SELECT
         ROUND(AVG(latency_ms)::numeric, 2) as avg_latency,
         MAX(latency_ms) as max_latency,
         ROUND(SUM(CASE WHEN error THEN 1 ELSE 0 END)::numeric / COUNT(*), 3) as error_rate
       FROM batch_metrics
       WHERE agent_id = $1
         AND workspace_id = $2
         AND recorded_at > NOW() - INTERVAL '1 hour'
       ORDER BY recorded_at DESC
       LIMIT $3`,
      [agentId, workspace, WINDOW_SIZE],
    );

    if (result.rows.length === 0) {
      // No history — start with a conservative batch size
      return 4;
    }

    const row = result.rows[0]!;
    const avgLatency = parseFloat(row.avg_latency || "0");
    // maxLatency could be used for outlier detection (reserved for future optimization)
    // const maxLatency = parseInt(row.max_latency || "0", 10);
    const errorRate = parseFloat(row.error_rate || "0");

    // Start with a base size
    let recommendedSize = 8;

    // If current latency is high, reduce batch size
    if (currentLatency > LATENCY_THRESHOLD_MS) {
      recommendedSize = Math.max(MIN_BATCH_SIZE, Math.ceil(recommendedSize * 0.5));
      log.info(
        `High latency (${currentLatency}ms) → reducing batch to ${recommendedSize}`,
      );
    }
    // If average latency is low and no errors, increase batch size
    else if (avgLatency < LATENCY_THRESHOLD_MS * 0.5 && errorRate < 0.05) {
      recommendedSize = Math.min(MAX_BATCH_SIZE, Math.ceil(recommendedSize * 1.5));
      log.info(
        `Low latency (${Math.round(avgLatency)}ms) → increasing batch to ${recommendedSize}`,
      );
    }
    // If we're seeing errors, be conservative
    else if (errorRate > 0.1) {
      recommendedSize = Math.max(MIN_BATCH_SIZE, Math.ceil(recommendedSize * 0.75));
      log.info(
        `High error rate (${(errorRate * 100).toFixed(1)}%) → reducing batch to ${recommendedSize}`,
      );
    }

    return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, recommendedSize));
  } catch (err) {
    log.warn(
      `Failed to compute batch size: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Safe default
    return 8;
  }
}

/**
 * Record batch execution metrics for future optimization.
 * @param agentId - Agent identifier
 * @param workspace - Workspace ID
 * @param batchSize - Number of items in the batch
 * @param latency - Execution time in ms
 * @param error - Whether an error occurred
 */
export async function recordBatchMetrics(
  agentId: string,
  workspace: string,
  batchSize: number,
  latency: number,
  error: boolean,
): Promise<void> {
  try {
    const pool = getPool();

    await pool.query(
      `INSERT INTO batch_metrics (agent_id, workspace_id, batch_size, latency_ms, error)
       VALUES ($1, $2, $3, $4, $5)`,
      [agentId, workspace, batchSize, Math.round(latency), error],
    );

    log.dim(
      `Recorded batch metrics: size=${batchSize}, latency=${Math.round(latency)}ms, error=${error}`,
    );
  } catch (err) {
    log.dim(`Failed to record batch metrics: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get batch sizing statistics for an agent.
 * @param agentId - Agent identifier
 * @returns Stats including recommended size, latency trends
 */
export async function getBatchSizingStats(agentId: string): Promise<{
  agentId: string;
  avgBatchSize: number;
  avgLatency: number;
  p95Latency: number;
  errorRate: number;
  recommendedSize: number;
}> {
  try {
    const pool = getPool();

    const result = await pool.query<{
      avg_batch: string;
      avg_latency: string;
      p95_latency: string;
      error_rate: string;
    }>(
      `SELECT
         ROUND(AVG(batch_size)::numeric, 2) as avg_batch,
         ROUND(AVG(latency_ms)::numeric, 2) as avg_latency,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::numeric, 2) as p95_latency,
         ROUND(SUM(CASE WHEN error THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) as error_rate
       FROM batch_metrics
       WHERE agent_id = $1
         AND recorded_at > NOW() - INTERVAL '24 hours'`,
      [agentId],
    );

    if (result.rows.length === 0 || !result.rows[0]) {
      return {
        agentId,
        avgBatchSize: 0,
        avgLatency: 0,
        p95Latency: 0,
        errorRate: 0,
        recommendedSize: 8,
      };
    }

    const row = result.rows[0];
    const avgLatency = parseFloat(row.avg_latency || "0");
    let recommendedSize = parseInt(row.avg_batch || "8", 10);

    if (avgLatency > LATENCY_THRESHOLD_MS) {
      recommendedSize = Math.max(MIN_BATCH_SIZE, Math.ceil(recommendedSize * 0.75));
    } else if (avgLatency < LATENCY_THRESHOLD_MS * 0.5) {
      recommendedSize = Math.min(MAX_BATCH_SIZE, Math.ceil(recommendedSize * 1.25));
    }

    return {
      agentId,
      avgBatchSize: parseFloat(row.avg_batch || "0"),
      avgLatency,
      p95Latency: parseFloat(row.p95_latency || "0"),
      errorRate: parseFloat(row.error_rate || "0"),
      recommendedSize,
    };
  } catch (err) {
    log.warn(`Failed to get batch stats: ${err instanceof Error ? err.message : String(err)}`);
    return {
      agentId,
      avgBatchSize: 0,
      avgLatency: 0,
      p95Latency: 0,
      errorRate: 0,
      recommendedSize: 8,
    };
  }
}
