import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("capacity-planning");

export interface AgentMetric {
  agentId: string;
  avgTasksPerDay: number;
  avgTokensPerTask: number;
  avgLatencyMs: number;
  utilizationPct: number;
}

export interface CapacityEstimate {
  id: string;
  workspaceId: string;
  teamId: string | null;
  horizon: string;
  agentMetrics: AgentMetric[];
  teamThroughput: number;
  recommendedTeamSize: number;
  bottlenecks: string[];
  createdAt: Date;
}

export async function estimateCapacity(
  workspaceId: string,
  opts?: { teamId?: string; horizon?: "day" | "week" | "month" },
): Promise<CapacityEstimate> {
  const pool = getPool();
  const horizon = opts?.horizon ?? "day";
  const intervalMap = { day: "1 day", week: "7 days", month: "30 days" };
  const interval = intervalMap[horizon];

  const { rows } = await pool.query(
    `SELECT metadata->>'agentId' AS agent_id,
            COUNT(*) FILTER (WHERE event = 'agent.completed') AS tasks,
            AVG((metadata->>'durationMs')::numeric) FILTER (WHERE event = 'agent.completed') AS avg_latency,
            AVG((metadata->>'tokens')::numeric) FILTER (WHERE event = 'agent.completed') AS avg_tokens
     FROM audit_log
     WHERE workspace_id::text = $1 AND created_at >= now() - $2::interval
     GROUP BY metadata->>'agentId'`,
    [workspaceId, interval],
  );

  const daysInHorizon = horizon === "day" ? 1 : horizon === "week" ? 7 : 30;
  const agentMetrics: AgentMetric[] = rows.map((r) => ({
    agentId: r.agent_id ?? "unknown",
    avgTasksPerDay: Math.round((parseInt(r.tasks, 10) / daysInHorizon) * 100) / 100,
    avgTokensPerTask: Math.round(parseFloat(r.avg_tokens ?? "0")),
    avgLatencyMs: Math.round(parseFloat(r.avg_latency ?? "0")),
    utilizationPct: Math.min(100, Math.round((parseInt(r.tasks, 10) / daysInHorizon / 100) * 100)),
  }));

  const teamThroughput = agentMetrics.reduce((s, m) => s + m.avgTasksPerDay, 0);
  const bottlenecks = agentMetrics
    .filter((m) => m.utilizationPct > 80)
    .map((m) => `${m.agentId} at ${m.utilizationPct}% utilization`);
  const recommendedTeamSize = Math.max(agentMetrics.length, Math.ceil(teamThroughput / 50));

  const estimate: CapacityEstimate = {
    id: randomUUID(),
    workspaceId,
    teamId: opts?.teamId ?? null,
    horizon,
    agentMetrics,
    teamThroughput,
    recommendedTeamSize,
    bottlenecks,
    createdAt: new Date(),
  };

  await pool.query(
    `INSERT INTO capacity_estimates (id, workspace_id, team_id, horizon, estimate)
     VALUES ($1,$2,$3,$4,$5)`,
    [estimate.id, workspaceId, estimate.teamId, horizon, JSON.stringify(estimate)],
  ).catch((err) => log.error("Failed to persist capacity estimate:", err));

  return estimate;
}

export async function getCapacityHistory(workspaceId: string): Promise<CapacityEstimate[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT estimate FROM capacity_estimates WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [workspaceId],
  );
  return rows.map((r) => r.estimate as CapacityEstimate);
}
