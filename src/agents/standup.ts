import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("standup");

export interface AgentSummary {
  agentId: string;
  tasksCompleted: number;
  decisionsCount: number;
  toolsUsed: string[];
  blockers: string[];
}

export interface StandupReport {
  id: string;
  workspaceId: string;
  teamId: string | null;
  period: { from: Date; to: Date };
  agentSummaries: AgentSummary[];
  generatedAt: Date;
}

const recentStandups = new Map<string, StandupReport>();
const workspaceStandups = new Map<string, Set<string>>();

export async function generateStandup(
  workspaceId: string,
  teamId?: string,
  agentIds?: string[],
  since?: Date,
): Promise<StandupReport> {
  const pool = getPool();
  const periodFrom = since ?? new Date(Date.now() - 24 * 3600 * 1000);
  const periodTo = new Date();

  let agentFilter = "";
  const params: unknown[] = [workspaceId, periodFrom, periodTo];
  if (agentIds?.length) {
    agentFilter = ` AND metadata->>'agentId' = ANY($4)`;
    params.push(agentIds);
  }

  const { rows } = await pool.query(
    `SELECT metadata->>'agentId' AS agent_id, event,
            COUNT(*) AS cnt,
            array_agg(DISTINCT COALESCE(metadata->>'toolName', '')) FILTER (WHERE event = 'tool.executed') AS tools
     FROM audit_log
     WHERE workspace_id::text = $1 AND created_at >= $2 AND created_at <= $3${agentFilter}
     GROUP BY metadata->>'agentId', event`,
    params,
  );

  const agentMap = new Map<string, AgentSummary>();
  for (const row of rows) {
    const aid = row.agent_id ?? "unknown";
    if (!agentMap.has(aid)) {
      agentMap.set(aid, { agentId: aid, tasksCompleted: 0, decisionsCount: 0, toolsUsed: [], blockers: [] });
    }
    const summary = agentMap.get(aid)!;
    if (row.event === "agent.completed") summary.tasksCompleted = parseInt(row.cnt, 10);
    if (row.event === "tool.executed") {
      summary.toolsUsed = (row.tools as string[]).filter(Boolean);
      summary.decisionsCount = parseInt(row.cnt, 10);
    }
  }

  const report: StandupReport = {
    id: randomUUID(),
    workspaceId,
    teamId: teamId ?? null,
    period: { from: periodFrom, to: periodTo },
    agentSummaries: Array.from(agentMap.values()),
    generatedAt: new Date(),
  };

  // Persist
  await pool.query(
    `INSERT INTO team_standups (id, workspace_id, team_id, period_from, period_to, summary)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [report.id, workspaceId, teamId ?? null, periodFrom, periodTo, JSON.stringify(report)],
  ).catch((err) => log.error("Failed to persist standup:", err));

  recentStandups.set(report.id, report);
  let ws = workspaceStandups.get(workspaceId);
  if (!ws) { ws = new Set(); workspaceStandups.set(workspaceId, ws); }
  ws.add(report.id);

  return report;
}

export function getStandups(workspaceId: string): StandupReport[] {
  const ids = workspaceStandups.get(workspaceId);
  if (!ids) return [];
  return Array.from(ids).map((id) => recentStandups.get(id)!).filter(Boolean)
    .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());
}

export function getStandup(id: string): StandupReport | null {
  return recentStandups.get(id) ?? null;
}
