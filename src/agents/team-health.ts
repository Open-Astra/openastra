import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface TeamHealthMetrics {
  id: string;
  workspaceId: string;
  teamId: string | null;
  window: string;
  period: { from: Date; to: Date };
  agentCount: number;
  latency: { p50: number; p95: number; p99: number };
  errorRate: number;
  tokenEfficiency: number;
  goalCompletionRate: number;
  activeAgents: number;
  taskThroughput: number;
}

export async function computeTeamHealth(
  workspaceId: string,
  teamId?: string,
  window?: "hour" | "day" | "week",
): Promise<TeamHealthMetrics> {
  const pool = getPool();
  const w = window ?? "day";
  const intervalMap = { hour: "1 hour", day: "1 day", week: "7 days" };
  const periodFrom = new Date(Date.now() - (w === "hour" ? 3600000 : w === "day" ? 86400000 : 604800000));
  const periodTo = new Date();

  const { rows } = await pool.query(
    `SELECT
       COUNT(DISTINCT metadata->>'agentId')::int AS agent_count,
       COUNT(*) FILTER (WHERE event = 'agent.completed')::int AS completed,
       COUNT(*) FILTER (WHERE event LIKE 'agent.%')::int AS total,
       AVG((metadata->>'durationMs')::numeric) FILTER (WHERE event = 'agent.completed') AS avg_latency,
       percentile_cont(0.50) WITHIN GROUP (ORDER BY (metadata->>'durationMs')::numeric)
         FILTER (WHERE event = 'agent.completed') AS p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY (metadata->>'durationMs')::numeric)
         FILTER (WHERE event = 'agent.completed') AS p95,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY (metadata->>'durationMs')::numeric)
         FILTER (WHERE event = 'agent.completed') AS p99,
       AVG((metadata->>'tokens')::numeric) FILTER (WHERE event = 'agent.completed') AS avg_tokens
     FROM audit_log
     WHERE workspace_id::text = $1 AND created_at >= now() - $2::interval`,
    [workspaceId, intervalMap[w]],
  );

  const r = rows[0] ?? {};
  const total = parseInt(r.total ?? "0", 10);
  const completed = parseInt(r.completed ?? "0", 10);
  const errorRate = total > 0 ? Math.round(((total - completed) / total) * 100) / 100 : 0;

  const metrics: TeamHealthMetrics = {
    id: randomUUID(),
    workspaceId,
    teamId: teamId ?? null,
    window: w,
    period: { from: periodFrom, to: periodTo },
    agentCount: parseInt(r.agent_count ?? "0", 10),
    latency: {
      p50: Math.round(parseFloat(r.p50 ?? "0")),
      p95: Math.round(parseFloat(r.p95 ?? "0")),
      p99: Math.round(parseFloat(r.p99 ?? "0")),
    },
    errorRate,
    tokenEfficiency: Math.round(parseFloat(r.avg_tokens ?? "0")),
    goalCompletionRate: total > 0 ? Math.round((completed / total) * 100) / 100 : 0,
    activeAgents: parseInt(r.agent_count ?? "0", 10),
    taskThroughput: completed,
  };

  // Persist snapshot
  await pool.query(
    `INSERT INTO team_health_snapshots (id, workspace_id, team_id, time_window, period_from, period_to, metrics)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [metrics.id, workspaceId, teamId ?? null, w, periodFrom, periodTo, JSON.stringify(metrics)],
  ).catch(() => {});

  return metrics;
}

export async function getHealthHistory(
  workspaceId: string,
  teamId?: string,
): Promise<TeamHealthMetrics[]> {
  const pool = getPool();
  const filter = teamId ? ` AND team_id = $2` : "";
  const params: unknown[] = [workspaceId];
  if (teamId) params.push(teamId);
  const { rows } = await pool.query(
    `SELECT metrics FROM team_health_snapshots
     WHERE workspace_id = $1${filter} ORDER BY created_at DESC LIMIT 100`,
    params,
  );
  return rows.map((r) => r.metrics as TeamHealthMetrics);
}
