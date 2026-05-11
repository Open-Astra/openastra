import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface EscalationLevel {
  agentId: string;
  timeoutSeconds: number;
  confidenceThreshold?: number;
}

export interface EscalationChain {
  id: string;
  workspaceId: string;
  name: string;
  levels: EscalationLevel[];
  active: boolean;
  createdAt: Date;
}

export interface Escalation {
  id: string;
  chainId: string;
  workspaceId: string;
  reason: string;
  context?: unknown;
  currentLevel: number;
  status: "active" | "acknowledged" | "resolved" | "expired";
  acknowledgedBy?: string;
  resolution?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

export async function createChain(
  workspaceId: string,
  chain: { name: string; levels: EscalationLevel[] },
): Promise<EscalationChain> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO escalation_chains (id, workspace_id, name, levels) VALUES ($1,$2,$3,$4)`,
    [id, workspaceId, chain.name, JSON.stringify(chain.levels)],
  );
  return { id, workspaceId, name: chain.name, levels: chain.levels, active: true, createdAt: new Date() };
}

export async function getChains(workspaceId: string): Promise<EscalationChain[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", name, levels, active, created_at AS "createdAt"
     FROM escalation_chains WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows as EscalationChain[];
}

export async function getChain(id: string): Promise<EscalationChain | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", name, levels, active, created_at AS "createdAt"
     FROM escalation_chains WHERE id = $1`,
    [id],
  );
  return (rows[0] as EscalationChain) ?? null;
}

export async function updateChain(id: string, updates: { name?: string; levels?: EscalationLevel[]; active?: boolean }): Promise<void> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  let idx = 2;
  if (updates.name) { sets.push(`name = $${idx++}`); vals.push(updates.name); }
  if (updates.levels) { sets.push(`levels = $${idx++}`); vals.push(JSON.stringify(updates.levels)); }
  if (updates.active !== undefined) { sets.push(`active = $${idx++}`); vals.push(updates.active); }
  await pool.query(`UPDATE escalation_chains SET ${sets.join(", ")} WHERE id = $1`, vals);
}

export async function deleteChain(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM escalation_chains WHERE id = $1`, [id]);
}

export async function triggerEscalation(
  chainId: string,
  workspaceId: string,
  reason: string,
  context?: unknown,
): Promise<Escalation> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO escalation_events (id, chain_id, workspace_id, reason, context)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, chainId, workspaceId, reason, context ? JSON.stringify(context) : null],
  );
  return { id, chainId, workspaceId, reason, context, currentLevel: 0, status: "active", createdAt: new Date() };
}

export async function acknowledgeEscalation(escalationId: string, agentId: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE escalation_events SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1`,
    [escalationId, agentId],
  );
}

export async function resolveEscalation(escalationId: string, resolution: string): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE escalation_events SET status = 'resolved', resolution = $2, resolved_at = now() WHERE id = $1`,
    [escalationId, resolution],
  );
}

export async function getEscalations(workspaceId: string, status?: string): Promise<Escalation[]> {
  const pool = getPool();
  const filter = status ? ` AND status = $2` : "";
  const params: unknown[] = [workspaceId];
  if (status) params.push(status);
  const { rows } = await pool.query(
    `SELECT id, chain_id AS "chainId", workspace_id AS "workspaceId", reason, context,
            current_level AS "currentLevel", status, acknowledged_by AS "acknowledgedBy",
            resolution, created_at AS "createdAt", resolved_at AS "resolvedAt"
     FROM escalation_events WHERE workspace_id = $1${filter} ORDER BY created_at DESC`,
    params,
  );
  return rows as Escalation[];
}
