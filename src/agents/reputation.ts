// ── Agent Reputation Scores ─────────────────────────────────────────
// Track per-agent success metrics within a workspace using UPSERT
// with incremental averaging. Overall score computed on read.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("reputation");

// ── Types ────────────────────────────────────────────────────────────

export interface AgentReputation {
  workspaceId: string;
  agentId: string;
  completionRate: number;
  satisfactionRate: number;
  toolReliability: number;
  avgConfidence: number;
  avgLatencyMs: number;
  overallScore: number;
  totalInteractions: number;
}

interface ReputationRow {
  workspace_id: string;
  agent_id: string;
  tasks_completed: number;
  tasks_failed: number;
  total_ratings: number;
  positive_ratings: number;
  tool_errors: number;
  total_tool_calls: number;
  avg_confidence: string;
  confidence_samples: number;
  avg_latency_ms: string;
  latency_samples: number;
}

// ── Score Computation ────────────────────────────────────────────────

const MAX_LATENCY_MS = 30000;

function computeReputation(row: ReputationRow): AgentReputation {
  const totalTasks = row.tasks_completed + row.tasks_failed;
  const completionRate = totalTasks > 0 ? row.tasks_completed / totalTasks : 0;
  const satisfactionRate = row.total_ratings > 0 ? row.positive_ratings / row.total_ratings : 0;
  const toolReliability = row.total_tool_calls > 0 ? 1 - row.tool_errors / row.total_tool_calls : 1;
  const avgConfidence = parseFloat(row.avg_confidence) || 0;
  const avgLatencyMs = parseFloat(row.avg_latency_ms) || 0;
  const normalizedLatency = 1 - Math.min(avgLatencyMs, MAX_LATENCY_MS) / MAX_LATENCY_MS;

  const overallScore =
    0.3 * completionRate +
    0.25 * satisfactionRate +
    0.2 * toolReliability +
    0.15 * avgConfidence +
    0.1 * normalizedLatency;

  return {
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    completionRate,
    satisfactionRate,
    toolReliability,
    avgConfidence,
    avgLatencyMs,
    overallScore,
    totalInteractions: totalTasks,
  };
}

// ── Read Functions ───────────────────────────────────────────────────

export async function getReputation(
  workspaceId: string,
  agentId: string,
): Promise<AgentReputation> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_reputation WHERE workspace_id = $1 AND agent_id = $2`,
    [workspaceId, agentId],
  );

  if (rows.length === 0) {
    return {
      workspaceId,
      agentId,
      completionRate: 0,
      satisfactionRate: 0,
      toolReliability: 1,
      avgConfidence: 0,
      avgLatencyMs: 0,
      overallScore: 0,
      totalInteractions: 0,
    };
  }

  return computeReputation(rows[0] as ReputationRow);
}

export async function getWorkspaceReputations(
  workspaceId: string,
): Promise<AgentReputation[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM agent_reputation WHERE workspace_id = $1 ORDER BY updated_at DESC`,
    [workspaceId],
  );

  return (rows as ReputationRow[]).map(computeReputation);
}

// ── Record Functions (UPSERT) ────────────────────────────────────────

export async function recordTaskCompletion(
  workspaceId: string,
  agentId: string,
  success: boolean,
): Promise<void> {
  const pool = getPool();
  const field = success ? "tasks_completed" : "tasks_failed";

  try {
    await pool.query(
      `INSERT INTO agent_reputation (workspace_id, agent_id, ${field})
       VALUES ($1, $2, 1)
       ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET ${field} = agent_reputation.${field} + 1, updated_at = now()`,
      [workspaceId, agentId],
    );
  } catch (err) {
    log.error("Failed to record task completion:", err);
  }
}

export async function recordRating(
  workspaceId: string,
  agentId: string,
  positive: boolean,
): Promise<void> {
  const pool = getPool();
  const positiveInc = positive ? 1 : 0;

  try {
    await pool.query(
      `INSERT INTO agent_reputation (workspace_id, agent_id, total_ratings, positive_ratings)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET
         total_ratings = agent_reputation.total_ratings + 1,
         positive_ratings = agent_reputation.positive_ratings + $3,
         updated_at = now()`,
      [workspaceId, agentId, positiveInc],
    );
  } catch (err) {
    log.error("Failed to record rating:", err);
  }
}

export async function recordToolOutcome(
  workspaceId: string,
  agentId: string,
  success: boolean,
): Promise<void> {
  const pool = getPool();
  const errorInc = success ? 0 : 1;

  try {
    await pool.query(
      `INSERT INTO agent_reputation (workspace_id, agent_id, total_tool_calls, tool_errors)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET
         total_tool_calls = agent_reputation.total_tool_calls + 1,
         tool_errors = agent_reputation.tool_errors + $3,
         updated_at = now()`,
      [workspaceId, agentId, errorInc],
    );
  } catch (err) {
    log.error("Failed to record tool outcome:", err);
  }
}

export async function recordConfidence(
  workspaceId: string,
  agentId: string,
  confidence: number,
): Promise<void> {
  const pool = getPool();
  const clampedConfidence = Math.max(0, Math.min(1, confidence));

  try {
    await pool.query(
      `INSERT INTO agent_reputation (workspace_id, agent_id, avg_confidence, confidence_samples)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET
         avg_confidence = (agent_reputation.avg_confidence * agent_reputation.confidence_samples + $3)
                          / (agent_reputation.confidence_samples + 1),
         confidence_samples = agent_reputation.confidence_samples + 1,
         updated_at = now()`,
      [workspaceId, agentId, clampedConfidence],
    );
  } catch (err) {
    log.error("Failed to record confidence:", err);
  }
}

export async function recordLatency(
  workspaceId: string,
  agentId: string,
  latencyMs: number,
): Promise<void> {
  const pool = getPool();

  try {
    await pool.query(
      `INSERT INTO agent_reputation (workspace_id, agent_id, avg_latency_ms, latency_samples)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (workspace_id, agent_id)
       DO UPDATE SET
         avg_latency_ms = (agent_reputation.avg_latency_ms * agent_reputation.latency_samples + $3)
                          / (agent_reputation.latency_samples + 1),
         latency_samples = agent_reputation.latency_samples + 1,
         updated_at = now()`,
      [workspaceId, agentId, latencyMs],
    );
  } catch (err) {
    log.error("Failed to record latency:", err);
  }
}
