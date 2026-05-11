import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("team-optimizer");

export interface ComboMetrics {
  agents: string[];
  successRate: number;
  avgLatencyMs: number;
  avgCost: number;
  taskCount: number;
}

export interface TeamPerformanceAnalysis {
  workspaceId: string;
  teamId?: string;
  agentCombos: ComboMetrics[];
  bestCombo: string[];
  analysisDate: string;
}

export interface TeamRecommendation {
  id: string;
  workspaceId: string;
  taskType: string;
  recommendedAgents: string[];
  reasoning: string[];
  estimatedSuccessRate: number;
  estimatedCost: number;
  createdAt: string;
}

export async function analyzeTeamPerformance(
  workspaceId: string,
  teamId?: string,
): Promise<TeamPerformanceAnalysis> {
  const pool = getPool();

  const teamFilter = teamId
    ? `AND metadata->>'teamId' = $2`
    : "";
  const params: unknown[] = [workspaceId];
  if (teamId) params.push(teamId);

  const { rows } = await pool.query<{
    agent_id: string;
    total: string;
    successes: string;
    avg_latency: string;
    avg_cost: string;
  }>(
    `SELECT
       metadata->>'agentId' AS agent_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE metadata->>'status' = 'completed') AS successes,
       AVG(COALESCE((metadata->>'durationMs')::numeric, 0)) AS avg_latency,
       AVG(COALESCE((metadata->>'costUsd')::numeric, 0)) AS avg_cost
     FROM audit_log
     WHERE event = 'agent.completed'
       AND workspace_id::text = $1
       ${teamFilter}
       AND created_at > NOW() - INTERVAL '30 days'
     GROUP BY metadata->>'agentId'`,
    params,
  ).catch(() => ({ rows: [] as { agent_id: string; total: string; successes: string; avg_latency: string; avg_cost: string }[] }));

  const agentCombos: ComboMetrics[] = rows.map((r) => ({
    agents: [r.agent_id],
    successRate: parseInt(r.total, 10) > 0
      ? parseInt(r.successes, 10) / parseInt(r.total, 10)
      : 0,
    avgLatencyMs: Math.round(parseFloat(r.avg_latency || "0")),
    avgCost: parseFloat(r.avg_cost || "0"),
    taskCount: parseInt(r.total, 10),
  }));

  agentCombos.sort((a, b) => b.successRate - a.successRate || a.avgLatencyMs - b.avgLatencyMs);

  const bestCombo = agentCombos.length > 0 ? agentCombos[0]!.agents : [];
  const analysisDate = new Date().toISOString();

  const analysis: TeamPerformanceAnalysis = {
    workspaceId,
    teamId,
    agentCombos,
    bestCombo,
    analysisDate,
  };

  const id = randomUUID();
  await pool
    .query(
      `INSERT INTO team_performance_analyses (id, workspace_id, team_id, analysis)
       VALUES ($1, $2, $3, $4)`,
      [id, workspaceId, teamId ?? null, JSON.stringify(analysis)],
    )
    .catch((err) => log.warn(`Failed to store analysis: ${err}`));

  log.info(`Team performance analysis complete workspace=${workspaceId} combos=${agentCombos.length}`);
  return analysis;
}

export async function recommendTeam(
  workspaceId: string,
  taskType: string,
  constraints?: { maxSize?: number; requiredSkills?: string[]; maxBudget?: number },
): Promise<TeamRecommendation> {
  const pool = getPool();

  const { rows } = await pool.query<{
    agent_id: string;
    success_rate: string;
    avg_cost: string;
    task_count: string;
  }>(
    `SELECT
       metadata->>'agentId' AS agent_id,
       COUNT(*) FILTER (WHERE metadata->>'status' = 'completed')::float / GREATEST(COUNT(*), 1) AS success_rate,
       AVG(COALESCE((metadata->>'costUsd')::numeric, 0)) AS avg_cost,
       COUNT(*) AS task_count
     FROM audit_log
     WHERE event = 'agent.completed'
       AND workspace_id::text = $1
       AND metadata->>'taskType' = $2
       AND created_at > NOW() - INTERVAL '90 days'
     GROUP BY metadata->>'agentId'
     ORDER BY success_rate DESC, avg_cost ASC`,
    [workspaceId, taskType],
  ).catch(() => ({ rows: [] as { agent_id: string; success_rate: string; avg_cost: string; task_count: string }[] }));

  const maxSize = constraints?.maxSize ?? 5;
  const maxBudget = constraints?.maxBudget ?? Infinity;

  let totalCost = 0;
  const recommended: string[] = [];
  const reasoning: string[] = [];

  for (const r of rows) {
    if (recommended.length >= maxSize) break;
    const cost = parseFloat(r.avg_cost || "0");
    if (totalCost + cost > maxBudget) continue;

    recommended.push(r.agent_id);
    totalCost += cost;
    reasoning.push(
      `${r.agent_id}: ${(parseFloat(r.success_rate) * 100).toFixed(1)}% success over ${r.task_count} tasks`,
    );
  }

  const estimatedSuccessRate = rows.length > 0
    ? parseFloat(rows[0]!.success_rate)
    : 0;

  const id = randomUUID();
  const rec: TeamRecommendation = {
    id,
    workspaceId,
    taskType,
    recommendedAgents: recommended,
    reasoning,
    estimatedSuccessRate,
    estimatedCost: totalCost,
    createdAt: new Date().toISOString(),
  };

  await pool
    .query(
      `INSERT INTO team_recommendations (id, workspace_id, task_type, recommended_agents, reasoning, estimated_success_rate, estimated_cost)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, workspaceId, taskType, recommended, reasoning, rec.estimatedSuccessRate, rec.estimatedCost],
    )
    .catch((err) => log.warn(`Failed to store recommendation: ${err}`));

  log.info(`Team recommendation for taskType=${taskType}: ${recommended.join(", ")}`);
  return rec;
}

export async function getRecommendationHistory(workspaceId: string): Promise<TeamRecommendation[]> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    task_type: string;
    recommended_agents: string[];
    reasoning: string[];
    estimated_success_rate: string;
    estimated_cost: string;
    created_at: string;
  }>(
    `SELECT id, workspace_id, task_type, recommended_agents, reasoning,
            estimated_success_rate, estimated_cost, created_at
     FROM team_recommendations WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT 100`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    taskType: r.task_type,
    recommendedAgents: r.recommended_agents,
    reasoning: r.reasoning ?? [],
    estimatedSuccessRate: parseFloat(r.estimated_success_rate ?? "0"),
    estimatedCost: parseFloat(r.estimated_cost ?? "0"),
    createdAt: r.created_at,
  }));
}

export async function getRecommendation(id: string): Promise<TeamRecommendation | null> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    task_type: string;
    recommended_agents: string[];
    reasoning: string[];
    estimated_success_rate: string;
    estimated_cost: string;
    created_at: string;
  }>(
    `SELECT id, workspace_id, task_type, recommended_agents, reasoning,
            estimated_success_rate, estimated_cost, created_at
     FROM team_recommendations WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    taskType: r.task_type,
    recommendedAgents: r.recommended_agents,
    reasoning: r.reasoning ?? [],
    estimatedSuccessRate: parseFloat(r.estimated_success_rate ?? "0"),
    estimatedCost: parseFloat(r.estimated_cost ?? "0"),
    createdAt: r.created_at,
  };
}
