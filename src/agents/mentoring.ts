import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";
export interface MentorshipPair {
  id: string;
  workspaceId: string;
  mentorId: string;
  menteeId: string;
  focus: string[];
  status: string;
  sessionsCount: number;
  createdAt: Date;
}

export interface MentoringSession {
  id: string;
  pairId: string;
  insights: { promptPatterns?: string[]; toolStrategies?: string[]; heuristics?: string[] };
  appliedCount: number;
  createdAt: Date;
}

export async function createMentorshipPair(
  workspaceId: string,
  mentorId: string,
  menteeId: string,
  focus: string[],
): Promise<MentorshipPair> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO mentorship_pairs (id, workspace_id, mentor_id, mentee_id, focus)
     VALUES ($1,$2,$3,$4,$5)`,
    [id, workspaceId, mentorId, menteeId, focus],
  );
  return { id, workspaceId, mentorId, menteeId, focus, status: "active", sessionsCount: 0, createdAt: new Date() };
}

export async function recordMentoringSession(
  pairId: string,
  insights: MentoringSession["insights"],
): Promise<MentoringSession> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO mentoring_sessions (id, pair_id, insights) VALUES ($1,$2,$3)`,
    [id, pairId, JSON.stringify(insights)],
  );
  await pool.query(
    `UPDATE mentorship_pairs SET sessions_count = sessions_count + 1 WHERE id = $1`,
    [pairId],
  );
  return { id, pairId, insights, appliedCount: 0, createdAt: new Date() };
}

export async function getMentorshipPairs(workspaceId: string): Promise<MentorshipPair[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", mentor_id AS "mentorId", mentee_id AS "menteeId",
            focus, status, sessions_count AS "sessionsCount", created_at AS "createdAt"
     FROM mentorship_pairs WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  return rows as MentorshipPair[];
}

export async function getMentorshipPair(id: string): Promise<MentorshipPair | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", mentor_id AS "mentorId", mentee_id AS "menteeId",
            focus, status, sessions_count AS "sessionsCount", created_at AS "createdAt"
     FROM mentorship_pairs WHERE id = $1`,
    [id],
  );
  return (rows[0] as MentorshipPair) ?? null;
}

export async function endMentorship(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(`UPDATE mentorship_pairs SET status = 'ended' WHERE id = $1`, [id]);
}

export async function getMentoringSessions(pairId: string): Promise<MentoringSession[]> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, pair_id AS "pairId", insights, applied_count AS "appliedCount", created_at AS "createdAt"
     FROM mentoring_sessions WHERE pair_id = $1 ORDER BY created_at DESC`,
    [pairId],
  );
  return rows as MentoringSession[];
}
