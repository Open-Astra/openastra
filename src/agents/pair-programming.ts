import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface PairTurn {
  id: string;
  agentId: string;
  role: "generate" | "review" | "interrupt";
  content: string;
  createdAt: Date;
}

export interface PairSession {
  id: string;
  workspaceId: string;
  generatorId: string;
  reviewerId: string;
  task: string;
  status: "active" | "completed" | "abandoned";
  turns: PairTurn[];
  qualityScore: number | null;
  createdAt: Date;
}

export async function createPairSession(
  workspaceId: string,
  generatorId: string,
  reviewerId: string,
  task: string,
): Promise<PairSession> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO pair_sessions (id, workspace_id, generator_id, reviewer_id, task)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, workspaceId, generatorId, reviewerId, task],
  );
  return { id, workspaceId, generatorId, reviewerId, task, status: "active", turns: [], qualityScore: null, createdAt: new Date() };
}

export async function addTurn(
  sessionId: string,
  agentId: string,
  role: PairTurn["role"],
  content: string,
): Promise<PairTurn> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO pair_turns (id, session_id, agent_id, role, content) VALUES ($1,$2,$3,$4,$5)`,
    [id, sessionId, agentId, role, content],
  );
  return { id, agentId, role, content, createdAt: new Date() };
}

export async function endSession(
  sessionId: string,
  outcome: "completed" | "abandoned",
  qualityScore?: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE pair_sessions SET status = $2, quality_score = $3, ended_at = now() WHERE id = $1`,
    [sessionId, outcome, qualityScore ?? null],
  );
}

export async function getPairSessions(workspaceId: string): Promise<PairSession[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", generator_id AS "generatorId",
            reviewer_id AS "reviewerId", task, status, quality_score AS "qualityScore",
            created_at AS "createdAt"
     FROM pair_sessions WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return (rows as PairSession[]).map((s) => ({ ...s, turns: [] }));
}

export async function getPairSession(sessionId: string): Promise<PairSession | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", generator_id AS "generatorId",
            reviewer_id AS "reviewerId", task, status, quality_score AS "qualityScore",
            created_at AS "createdAt"
     FROM pair_sessions WHERE id = $1`,
    [sessionId],
  );
  if (!rows[0]) return null;
  const session = rows[0] as PairSession;
  const { rows: turns } = await pool.query(
    `SELECT id, agent_id AS "agentId", role, content, created_at AS "createdAt"
     FROM pair_turns WHERE session_id = $1 ORDER BY created_at`,
    [sessionId],
  );
  session.turns = turns as PairTurn[];
  return session;
}
