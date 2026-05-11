import { randomUUID } from "node:crypto";
import { getPool } from "../config/postgres.js";

export interface KbEntry {
  id: string;
  workspaceId: string;
  teamId: string | null;
  agentId: string;
  title: string;
  content: string;
  tags: string[];
  relevanceScore: number;
  citationCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export async function addEntry(
  workspaceId: string,
  entry: { teamId?: string; agentId: string; title: string; content: string; tags?: string[] },
): Promise<KbEntry> {
  const id = randomUUID();
  const pool = getPool();
  await pool.query(
    `INSERT INTO team_kb_entries (id, workspace_id, team_id, agent_id, title, content, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, workspaceId, entry.teamId ?? null, entry.agentId, entry.title, entry.content, entry.tags ?? []],
  );
  return {
    id, workspaceId, teamId: entry.teamId ?? null, agentId: entry.agentId,
    title: entry.title, content: entry.content, tags: entry.tags ?? [],
    relevanceScore: 1.0, citationCount: 0, createdAt: new Date(), updatedAt: new Date(),
  };
}

export async function searchEntries(
  workspaceId: string,
  query: string,
  opts?: { teamId?: string; limit?: number },
): Promise<KbEntry[]> {
  const pool = getPool();
  const limit = Math.min(opts?.limit ?? 20, 100);
  const teamFilter = opts?.teamId ? ` AND team_id = $4` : "";
  const params: unknown[] = [workspaceId, `%${query}%`, limit];
  if (opts?.teamId) params.push(opts.teamId);
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", team_id AS "teamId", agent_id AS "agentId",
            title, content, tags, relevance_score AS "relevanceScore",
            citation_count AS "citationCount", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM team_kb_entries
     WHERE workspace_id = $1 AND (title ILIKE $2 OR content ILIKE $2)${teamFilter}
     ORDER BY relevance_score DESC LIMIT $3`,
    params,
  );
  return rows as KbEntry[];
}

export async function getEntries(workspaceId: string, teamId?: string): Promise<KbEntry[]> {
  const pool = getPool();
  const filter = teamId ? ` AND team_id = $2` : "";
  const params: unknown[] = [workspaceId];
  if (teamId) params.push(teamId);
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", team_id AS "teamId", agent_id AS "agentId",
            title, content, tags, relevance_score AS "relevanceScore",
            citation_count AS "citationCount", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM team_kb_entries WHERE workspace_id = $1${filter} ORDER BY relevance_score DESC`,
    params,
  );
  return rows as KbEntry[];
}

export async function getEntry(id: string): Promise<KbEntry | null> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, workspace_id AS "workspaceId", team_id AS "teamId", agent_id AS "agentId",
            title, content, tags, relevance_score AS "relevanceScore",
            citation_count AS "citationCount", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM team_kb_entries WHERE id = $1`,
    [id],
  );
  return (rows[0] as KbEntry) ?? null;
}

export async function updateEntry(id: string, updates: { title?: string; content?: string; tags?: string[] }): Promise<void> {
  const pool = getPool();
  const sets: string[] = ["updated_at = now()"];
  const vals: unknown[] = [id];
  let idx = 2;
  if (updates.title) { sets.push(`title = $${idx++}`); vals.push(updates.title); }
  if (updates.content) { sets.push(`content = $${idx++}`); vals.push(updates.content); }
  if (updates.tags) { sets.push(`tags = $${idx++}`); vals.push(updates.tags); }
  await pool.query(`UPDATE team_kb_entries SET ${sets.join(", ")} WHERE id = $1`, vals);
}

export async function deleteEntry(id: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM team_kb_entries WHERE id = $1`, [id]);
}

export async function upvoteEntry(entryId: string, agentId: string): Promise<void> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `INSERT INTO team_kb_votes (entry_id, agent_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [entryId, agentId],
  );
  if (rowCount && rowCount > 0) {
    await pool.query(
      `UPDATE team_kb_entries SET relevance_score = relevance_score + 0.1 WHERE id = $1`,
      [entryId],
    );
  }
}

export async function pruneStaleEntries(workspaceId: string, olderThanDays: number): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM team_kb_entries
     WHERE workspace_id = $1 AND relevance_score < 0.5
       AND created_at < now() - ($2 || ' days')::interval`,
    [workspaceId, olderThanDays],
  );
  return rowCount ?? 0;
}
