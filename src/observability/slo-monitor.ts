import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("slo-monitor");

export async function checkSlos(workspaceId: string): Promise<void> {
  const pool = getPool();

  const slos = await pool.query<{
    id: string;
    agent_id: string;
    metric: string;
    threshold: number;
    window_minutes: number;
    alert_webhook_url: string | null;
  }>(
    `SELECT id, agent_id, metric, threshold, window_minutes, alert_webhook_url
     FROM slo_definitions WHERE workspace_id = $1`,
    [workspaceId],
  );

  for (const slo of slos.rows) {
    let measuredValue: number | null = null;

    if (slo.metric === "p95_latency_ms") {
      const result = await pool.query<{ p95: number }>(
        `SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms) as p95
         FROM agent_traces
         WHERE agent_id = $1 AND workspace_id = $2
           AND started_at > NOW() - INTERVAL '1 minute' * $3`,
        [slo.agent_id, workspaceId, slo.window_minutes],
      );
      measuredValue = result.rows[0]?.p95 ?? 0;
    } else if (slo.metric === "error_rate_pct") {
      const result = await pool.query<{ error_rate: number }>(
        `SELECT 100.0 * COUNT(*) FILTER (WHERE final_status = 'failed') / NULLIF(COUNT(*), 0) as error_rate
         FROM agent_traces
         WHERE agent_id = $1 AND workspace_id = $2
           AND started_at > NOW() - INTERVAL '1 minute' * $3`,
        [slo.agent_id, workspaceId, slo.window_minutes],
      );
      measuredValue = result.rows[0]?.error_rate ?? 0;
    }

    if (measuredValue !== null && measuredValue > slo.threshold) {
      // Record violation
      await pool.query(
        `INSERT INTO slo_violations (slo_id, measured_value, threshold) VALUES ($1, $2, $3)`,
        [slo.id, measuredValue, slo.threshold],
      ).catch(() => {});

      // Fire alert webhook (SSRF-guarded)
      if (slo.alert_webhook_url && !(await isBlockedUrl(slo.alert_webhook_url))) {
        fetch(slo.alert_webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sloId: slo.id,
            metric: slo.metric,
            measured: measuredValue,
            threshold: slo.threshold,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    }
  }
}

export async function checkAllWorkspaceSlos(): Promise<void> {
  const pool = getPool();
  const workspaces = await pool.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM slo_definitions`,
  );
  for (const row of workspaces.rows) {
    await checkSlos(row.workspace_id).catch((err: unknown) => {
      log.error(`SLO check for workspace ${row.workspace_id}:`, err);
    });
  }
}
