import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("liaison");

export interface Liaison {
  id: string;
  workspaceId: string;
  agentId: string;
  teamA: string;
  teamB: string;
  active: boolean;
  handoffCount: number;
  createdAt: string;
}

export interface LiaisonHandoff {
  id: string;
  liaisonId: string;
  fromTeam: string;
  toTeam: string;
  summary: string;
  createdAt: string;
}

export async function createLiaison(
  workspaceId: string,
  agentId: string,
  teamA: string,
  teamB: string,
): Promise<Liaison> {
  const id = randomUUID();
  const { rows } = await getPool().query<{ created_at: string }>(
    `INSERT INTO agent_liaisons (id, workspace_id, agent_id, team_a, team_b)
     VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
    [id, workspaceId, agentId, teamA, teamB],
  );
  log.info(`Created liaison ${id} agent=${agentId} teams=${teamA}<->${teamB}`);
  return {
    id,
    workspaceId,
    agentId,
    teamA,
    teamB,
    active: true,
    handoffCount: 0,
    createdAt: rows[0]!.created_at,
  };
}

export async function recordHandoff(
  liaisonId: string,
  fromTeam: string,
  toTeam: string,
  summary: string,
): Promise<LiaisonHandoff> {
  const id = randomUUID();
  const pool = getPool();

  const { rows } = await pool.query<{ created_at: string }>(
    `INSERT INTO liaison_handoffs (id, liaison_id, from_team, to_team, summary)
     VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
    [id, liaisonId, fromTeam, toTeam, summary],
  );

  await pool.query(
    `UPDATE agent_liaisons SET handoff_count = handoff_count + 1 WHERE id = $1`,
    [liaisonId],
  );

  log.info(`Handoff recorded: liaison=${liaisonId} ${fromTeam}->${toTeam}`);
  return {
    id,
    liaisonId,
    fromTeam,
    toTeam,
    summary,
    createdAt: rows[0]!.created_at,
  };
}

export async function getLiaisons(workspaceId: string): Promise<Liaison[]> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    team_a: string;
    team_b: string;
    active: boolean;
    handoff_count: number;
    created_at: string;
  }>(
    `SELECT id, workspace_id, agent_id, team_a, team_b, active, handoff_count, created_at
     FROM agent_liaisons WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    teamA: r.team_a,
    teamB: r.team_b,
    active: r.active,
    handoffCount: r.handoff_count,
    createdAt: r.created_at,
  }));
}

export async function getLiaison(id: string): Promise<Liaison | null> {
  const { rows } = await getPool().query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    team_a: string;
    team_b: string;
    active: boolean;
    handoff_count: number;
    created_at: string;
  }>(
    `SELECT id, workspace_id, agent_id, team_a, team_b, active, handoff_count, created_at
     FROM agent_liaisons WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    teamA: r.team_a,
    teamB: r.team_b,
    active: r.active,
    handoffCount: r.handoff_count,
    createdAt: r.created_at,
  };
}

export async function deactivateLiaison(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE agent_liaisons SET active = false WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function getLiaisonHandoffs(liaisonId: string): Promise<LiaisonHandoff[]> {
  const { rows } = await getPool().query<{
    id: string;
    liaison_id: string;
    from_team: string;
    to_team: string;
    summary: string;
    created_at: string;
  }>(
    `SELECT id, liaison_id, from_team, to_team, summary, created_at
     FROM liaison_handoffs WHERE liaison_id = $1 ORDER BY created_at DESC`,
    [liaisonId],
  );
  return rows.map((r) => ({
    id: r.id,
    liaisonId: r.liaison_id,
    fromTeam: r.from_team,
    toTeam: r.to_team,
    summary: r.summary,
    createdAt: r.created_at,
  }));
}
