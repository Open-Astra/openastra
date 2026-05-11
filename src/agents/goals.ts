import { getPool } from "../config/postgres.js";

// ── Agent Goals ──────────────────────────────────────────────────────
// Per-agent goals stored in agent_goals table. Goals provide context for
// the agent loop and can track progress toward measurable outcomes.

export interface AgentGoal {
  id: string;
  workspaceId: string;
  agentId: string;
  uid: string;
  title: string;
  description: string;
  status: string;
  targetMetrics: Record<string, unknown>;
  progress: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Load all active goals for a given agent + user + workspace combination.
 */
export async function loadActiveGoals(
  agentId: string,
  uid: string,
  workspaceId: string,
): Promise<AgentGoal[]> {
  const pool = getPool();
  const result = await pool.query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    uid: string;
    title: string;
    description: string;
    status: string;
    target_metrics: Record<string, unknown>;
    progress: Record<string, unknown>;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, workspace_id, agent_id, uid, title, description, status,
            target_metrics, progress, created_at, updated_at
     FROM agent_goals
     WHERE workspace_id = $1
       AND agent_id = $2
       AND uid = $3
       AND status = 'active'
     ORDER BY created_at ASC`,
    [workspaceId, agentId, uid],
  );

  return result.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    uid: row.uid,
    title: row.title,
    description: row.description,
    status: row.status,
    targetMetrics: row.target_metrics,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Merge a progress delta into a goal's existing progress JSONB field.
 */
export async function updateGoalProgress(
  goalId: string,
  delta: Record<string, unknown>,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE agent_goals
     SET progress = progress || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2`,
    [JSON.stringify(delta), goalId],
  );
}

/**
 * Format a list of goals as a bullet-point string for injection into a system prompt.
 */
export function buildGoalContext(goals: AgentGoal[]): string {
  if (goals.length === 0) return "";

  const lines = goals.map(
    (g) => `- ${g.title}${g.description ? `: ${g.description}` : ""}`,
  );
  return `Active goals:\n${lines.join("\n")}`;
}
