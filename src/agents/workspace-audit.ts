// ── Workspace Audit Trail ───────────────────────────────────────────
// Comprehensive audit querying and aggregation for workspace-level
// agent actions, building on the existing audit_log table.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("workspace-audit");

// ── Types ────────────────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  workspaceId: string;
  agentId: string;
  action: string;
  details: Record<string, unknown>;
  traceId?: string;
  timestamp: string;
}

export interface AuditQuery {
  workspaceId: string;
  agentId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export interface AuditSummary {
  totalActions: number;
  byAgent: Record<string, number>;
  byAction: Record<string, number>;
  timeline: Array<{ hour: string; count: number }>;
}

// ── Query Audit Log ──────────────────────────────────────────────────

export async function queryAuditLog(
  query: AuditQuery,
): Promise<{ entries: AuditEntry[]; total: number }> {
  const pool = getPool();
  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [query.workspaceId];
  let paramIdx = 2;

  if (query.agentId) {
    conditions.push(`agent_id = $${paramIdx++}`);
    values.push(query.agentId);
  }

  if (query.action) {
    conditions.push(`action = $${paramIdx++}`);
    values.push(query.action);
  }

  if (query.from) {
    conditions.push(`created_at >= $${paramIdx++}`);
    values.push(query.from.toISOString());
  }

  if (query.to) {
    conditions.push(`created_at <= $${paramIdx++}`);
    values.push(query.to.toISOString());
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      values,
    );
    const total: number = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `SELECT id, workspace_id, agent_id, action, details, session_id, created_at
       FROM audit_log ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      [...values, limit, offset],
    );

    const entries: AuditEntry[] = dataResult.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      workspaceId: r.workspace_id as string,
      agentId: r.agent_id as string,
      action: r.action as string,
      details: (r.details ?? {}) as Record<string, unknown>,
      traceId: r.session_id as string | undefined,
      timestamp: (r.created_at as Date).toISOString(),
    }));

    return { entries, total };
  } catch (err) {
    log.error("Failed to query audit log:", err);
    return { entries: [], total: 0 };
  }
}

// ── Audit Summary ────────────────────────────────────────────────────

export async function getAuditSummary(
  workspaceId: string,
  from?: Date,
  to?: Date,
): Promise<AuditSummary> {
  const pool = getPool();
  const conditions: string[] = ["workspace_id = $1"];
  const values: unknown[] = [workspaceId];
  let paramIdx = 2;

  if (from) {
    conditions.push(`created_at >= $${paramIdx++}`);
    values.push(from.toISOString());
  }

  if (to) {
    conditions.push(`created_at <= $${paramIdx++}`);
    values.push(to.toISOString());
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  try {
    // Total count
    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM audit_log ${where}`,
      values,
    );
    const totalActions: number = countResult.rows[0]?.total ?? 0;

    // By agent
    const byAgentResult = await pool.query(
      `SELECT agent_id, COUNT(*)::int AS cnt FROM audit_log ${where} GROUP BY agent_id ORDER BY cnt DESC`,
      values,
    );
    const byAgent: Record<string, number> = {};
    for (const row of byAgentResult.rows) {
      byAgent[row.agent_id as string] = row.cnt as number;
    }

    // By action
    const byActionResult = await pool.query(
      `SELECT action, COUNT(*)::int AS cnt FROM audit_log ${where} GROUP BY action ORDER BY cnt DESC`,
      values,
    );
    const byAction: Record<string, number> = {};
    for (const row of byActionResult.rows) {
      byAction[row.action as string] = row.cnt as number;
    }

    // Timeline (hourly)
    const timelineResult = await pool.query(
      `SELECT DATE_TRUNC('hour', created_at) AS hour, COUNT(*)::int AS cnt
       FROM audit_log ${where}
       GROUP BY DATE_TRUNC('hour', created_at)
       ORDER BY hour`,
      values,
    );
    const timeline: Array<{ hour: string; count: number }> = timelineResult.rows.map(
      (r: Record<string, unknown>) => ({
        hour: (r.hour as Date).toISOString(),
        count: r.cnt as number,
      }),
    );

    return { totalActions, byAgent, byAction, timeline };
  } catch (err) {
    log.error("Failed to get audit summary:", err);
    return { totalActions: 0, byAgent: {}, byAction: {}, timeline: [] };
  }
}
