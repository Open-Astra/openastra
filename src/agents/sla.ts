import { getPool } from "../config/postgres.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("agent-sla");

// ── Types ────────────────────────────────────────────────────────────

export interface AgentSLA {
  workspaceId: string;
  agentId: string;
  maxLatencyMs: number;
  minConfidence: number;
  maxErrorRate: number;
  backupAgentId?: string;
  alertOnBreach: boolean;
}

export interface SLAStatus {
  agentId: string;
  withinSLA: boolean;
  avgLatencyMs: number;
  avgConfidence: number;
  errorRate: number;
  breaches: string[];
  measurementCount: number;
}

// ── Functions ────────────────────────────────────────────────────────

export async function setSLA(sla: AgentSLA): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO agent_slas (workspace_id, agent_id, max_latency_ms, min_confidence, max_error_rate, backup_agent_id, alert_on_breach)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (workspace_id, agent_id) DO UPDATE SET
       max_latency_ms = EXCLUDED.max_latency_ms,
       min_confidence = EXCLUDED.min_confidence,
       max_error_rate = EXCLUDED.max_error_rate,
       backup_agent_id = EXCLUDED.backup_agent_id,
       alert_on_breach = EXCLUDED.alert_on_breach,
       updated_at = now()`,
    [sla.workspaceId, sla.agentId, sla.maxLatencyMs, sla.minConfidence, sla.maxErrorRate, sla.backupAgentId ?? null, sla.alertOnBreach],
  );
}

export async function getSLA(workspaceId: string, agentId: string): Promise<AgentSLA | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT workspace_id, agent_id, max_latency_ms, min_confidence, max_error_rate, backup_agent_id, alert_on_breach
     FROM agent_slas WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
  if (rows.length === 0) return null;
  return rowToSLA(rows[0]);
}

export async function getWorkspaceSLAs(workspaceId: string): Promise<AgentSLA[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT workspace_id, agent_id, max_latency_ms, min_confidence, max_error_rate, backup_agent_id, alert_on_breach
     FROM agent_slas WHERE workspace_id = $1 ORDER BY agent_id`,
    [workspaceId],
  );
  return rows.map(rowToSLA);
}

export async function deleteSLA(workspaceId: string, agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `DELETE FROM agent_slas WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );
}

export async function recordMetric(
  workspaceId: string,
  agentId: string,
  latencyMs: number,
  confidence?: number,
  hadError?: boolean,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO sla_metrics (workspace_id, agent_id, latency_ms, confidence, had_error)
     VALUES ($1, $2, $3, $4, $5)`,
    [workspaceId, agentId, latencyMs, confidence ?? null, hadError ?? false],
  );

  // Check SLA after recording
  try {
    const sla = await getSLA(workspaceId, agentId);
    if (sla && sla.alertOnBreach) {
      const status = await checkSLAStatus(workspaceId, agentId);
      if (!status.withinSLA) {
        const bus = getEventBus();
        bus.emit("sla.breached" as never, {
          workspaceId,
          agentId,
          breaches: status.breaches,
          avgLatencyMs: status.avgLatencyMs,
          avgConfidence: status.avgConfidence,
          errorRate: status.errorRate,
          backupAgentId: sla.backupAgentId,
          timestamp: Date.now(),
        } as never);
      }
    }
  } catch {
    log.warn("Failed to check SLA after metric recording");
  }
}

export async function checkSLAStatus(
  workspaceId: string,
  agentId: string,
  windowMinutes?: number,
): Promise<SLAStatus> {
  const pool = getPool();
  const window = windowMinutes ?? 60;

  const sla = await getSLA(workspaceId, agentId);

  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS cnt,
       COALESCE(AVG(latency_ms), 0)::float AS avg_latency,
       COALESCE(AVG(confidence), 0)::float AS avg_confidence,
       COALESCE(AVG(CASE WHEN had_error THEN 1 ELSE 0 END), 0)::float AS error_rate
     FROM sla_metrics
     WHERE workspace_id = $1 AND agent_id = $2
       AND measured_at >= now() - INTERVAL '1 minute' * $3`,
    [workspaceId, agentId, window],
  );

  const r = rows[0];
  const avgLatencyMs = parseFloat(String(r.avg_latency));
  const avgConfidence = parseFloat(String(r.avg_confidence));
  const errorRate = parseFloat(String(r.error_rate));
  const measurementCount = r.cnt;

  const breaches: string[] = [];
  if (sla) {
    if (avgLatencyMs > sla.maxLatencyMs) breaches.push("latency");
    if (avgConfidence < sla.minConfidence && measurementCount > 0) breaches.push("confidence");
    if (errorRate > sla.maxErrorRate && measurementCount > 0) breaches.push("error_rate");
  }

  return {
    agentId,
    withinSLA: breaches.length === 0,
    avgLatencyMs,
    avgConfidence,
    errorRate,
    breaches,
    measurementCount,
  };
}

export async function getBreachingAgents(workspaceId: string): Promise<SLAStatus[]> {
  const slas = await getWorkspaceSLAs(workspaceId);
  const results: SLAStatus[] = [];
  for (const sla of slas) {
    const status = await checkSLAStatus(workspaceId, sla.agentId);
    if (!status.withinSLA) {
      results.push(status);
    }
  }
  return results;
}

// ── Helpers ──────────────────────────────────────────────────────────

function rowToSLA(r: Record<string, unknown>): AgentSLA {
  return {
    workspaceId: r.workspace_id as string,
    agentId: r.agent_id as string,
    maxLatencyMs: Number(r.max_latency_ms),
    minConfidence: parseFloat(String(r.min_confidence)),
    maxErrorRate: parseFloat(String(r.max_error_rate)),
    backupAgentId: (r.backup_agent_id as string) ?? undefined,
    alertOnBreach: r.alert_on_breach as boolean,
  };
}
