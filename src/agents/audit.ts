import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import type { AgentId } from "./types.js";

// ── Audit Action Types ─────────────────────────────────────────────

export type AuditAction =
  | "agent_spawn"
  | "agent_spawn_complete"
  | "agent_spawn_error"
  | "agent_message_sent"
  | "agent_message_received"
  | "tool_call"
  | "session_created"
  | "session_archived"
  | "swarm_complete"
  | "swarm_failed"
  | "swarm_plan_execute"
  | "swarm_plan_complete"
  | "curator_run";

// ── Audit Log Entry ────────────────────────────────────────────────

export interface AuditEntry {
  id: string;
  agentId: AgentId;
  action: AuditAction;
  details: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;
}

// ── Log Agent Action ───────────────────────────────────────────────

export async function logAgentAction(
  uid: string,
  agentId: AgentId,
  action: AuditAction,
  details: Record<string, unknown>,
  durationMs?: number,
): Promise<string> {
  const pool = getPool();
  const id = randomUUID();
  const timestamp = Date.now();

  await pool.query(
    `INSERT INTO audit_log (id, user_id, agent_id, action, details, timestamp)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [id, uid, agentId, action, JSON.stringify({ ...details, durationMs }), timestamp],
  );

  return id;
}
