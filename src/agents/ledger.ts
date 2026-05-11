import { getPool } from "../config/postgres.js";

// ── Persistent Sub-Agent Performance Ledger ─────────────────────────

export interface RoleLedger {
  roleId: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  totalLatencyMs: number;
  totalTokensUsed: number;
  totalCost: number;
  userUpvotes: number;
  userDownvotes: number;
  avgLatencyMs: number;
  successRate: number;
  avgTokensPerExec: number;
  fitnessScore: number;
  lastExecutedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ExecutionRecord {
  roleId: string;
  swarmId: string;
  instanceId: string;
  uid: string;
  success: boolean;
  latencyMs: number;
  tokensUsed: number;
  error?: string;
  timestamp: number;
}

export interface LeaderboardEntry {
  roleId: string;
  fitnessScore: number;
  successRate: number;
  avgLatencyMs: number;
  totalExecutions: number;
}

// ── Record Execution ────────────────────────────────────────────────

export async function recordExecution(record: ExecutionRecord): Promise<void> {
  const pool = getPool();

  // Log execution
  await pool.query(
    `INSERT INTO execution_log (agent_id, session_id, user_id, tool_name, duration_ms, token_usage, error, timestamp)
     VALUES ($1, NULL, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      record.roleId,
      record.uid,
      record.instanceId,
      record.latencyMs,
      JSON.stringify({ tokensUsed: record.tokensUsed }),
      record.error ?? null,
      record.timestamp,
    ],
  );

  // Upsert global role ledger
  await pool.query(
    `INSERT INTO role_ledger (agent_id, role, tokens_used, updated_at)
     VALUES ($1, 'global', $2, NOW())
     ON CONFLICT (agent_id, role)
     DO UPDATE SET tokens_used = role_ledger.tokens_used + $2, updated_at = NOW()`,
    [record.roleId, record.tokensUsed],
  );

  // Upsert user role ledger
  await pool.query(
    `INSERT INTO user_role_ledger (user_id, agent_id, tokens_used, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, agent_id)
     DO UPDATE SET tokens_used = user_role_ledger.tokens_used + $3, updated_at = NOW()`,
    [record.uid, record.roleId, record.tokensUsed],
  );
}

// ── Record User Feedback ────────────────────────────────────────────

export async function recordFeedback(
  roleId: string,
  _positive: boolean,
): Promise<void> {
  const pool = getPool();
  // Store feedback as an execution log entry with tool_name indicating feedback
  await pool.query(
    `INSERT INTO execution_log (agent_id, user_id, tool_name, duration_ms, token_usage, timestamp)
     VALUES ($1, 'system', 'feedback', 0, '{}'::jsonb, $2)`,
    [roleId, Date.now()],
  );
}

// ── Leaderboard ─────────────────────────────────────────────────────

export async function getLeaderboard(limit: number = 10): Promise<LeaderboardEntry[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    agent_id: string;
    tokens_used: string;
  }>(
    `SELECT agent_id, tokens_used FROM role_ledger
     WHERE role = 'global'
     ORDER BY tokens_used DESC LIMIT $1`,
    [limit],
  );

  return rows.map((r) => ({
    roleId: r.agent_id,
    fitnessScore: 50, // placeholder — would be computed from execution_log
    successRate: 0.8,
    avgLatencyMs: 0,
    totalExecutions: parseInt(String(r.tokens_used), 10),
  }));
}

// ── Get Role Ledger ─────────────────────────────────────────────────

export async function getRoleLedger(roleId: string): Promise<RoleLedger | null> {
  const pool = getPool();
  const { rows } = await pool.query<{ tokens_used: string }>(
    "SELECT tokens_used FROM role_ledger WHERE agent_id = $1 AND role = 'global'",
    [roleId],
  );

  if (rows.length === 0) return null;

  return {
    roleId,
    totalExecutions: 0,
    successCount: 0,
    failureCount: 0,
    totalLatencyMs: 0,
    totalTokensUsed: parseInt(String(rows[0]!.tokens_used), 10),
    totalCost: 0,
    userUpvotes: 0,
    userDownvotes: 0,
    avgLatencyMs: 0,
    successRate: 0,
    avgTokensPerExec: 0,
    fitnessScore: 50,
    lastExecutedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ── Identify Weak Performers ────────────────────────────────────────

export async function getWeakPerformers(
  _minExecutions: number = 10,
  _fitnessThreshold: number = 30,
): Promise<RoleLedger[]> {
  // Simplified — would query execution_log and aggregate
  return [];
}

