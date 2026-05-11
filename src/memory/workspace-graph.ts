import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "./embeddings.js";

// ── Workspace Graph Memory ───────────────────────────────────────────
// Shared knowledge graph entities scoped to a workspace (team-level).
// Similar to graph.ts but keyed by workspace_id instead of uid.

export interface WorkspaceGraphEntity {
  id: string;
  workspaceId: string;
  type: string;
  name: string;
  description: string;
  properties: Record<string, unknown>;
  reinforcementScore: number;
  accessCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceGraphSearchResult {
  id: string;
  name: string;
  description: string;
  type: string;
  score: number;
}

// ── Upsert Entity ────────────────────────────────────────────────────

export async function upsertWorkspaceEntity(
  workspaceId: string,
  type: string,
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
): Promise<WorkspaceGraphEntity> {
  const pool = getPool();
  const embedding = await generateEmbedding(`${name}: ${description}`).catch(() => null);

  // Try to find existing entity first
  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM workspace_graph_entities
     WHERE workspace_id = $1 AND LOWER(name) = LOWER($2)`,
    [workspaceId, name],
  );

  if (existing.length > 0) {
    await pool.query(
      `UPDATE workspace_graph_entities
       SET description = $3, properties = properties || $4::jsonb, updated_at = NOW(),
           reinforcement_score = LEAST(1.0, reinforcement_score + 0.05),
           embedding = COALESCE($5, embedding)
       WHERE id = $1`,
      [existing[0]!.id, workspaceId, description, JSON.stringify(properties), embedding ? `[${embedding.join(",")}]` : null],
    );
  } else {
    await pool.query(
      `INSERT INTO workspace_graph_entities (workspace_id, type, name, description, properties, embedding)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [workspaceId, type, name, description, JSON.stringify(properties), embedding ? `[${embedding.join(",")}]` : null],
    );
  }

  const { rows } = await pool.query<WorkspaceGraphEntity>(
    `SELECT id, workspace_id as "workspaceId", type, name, description, properties,
            reinforcement_score as "reinforcementScore", access_count as "accessCount",
            created_at::text as "createdAt", updated_at::text as "updatedAt"
     FROM workspace_graph_entities
     WHERE workspace_id = $1 AND LOWER(name) = LOWER($2)`,
    [workspaceId, name],
  );

  return rows[0]!;
}

// ── Search Workspace Graph ────────────────────────────────────────────

export async function searchWorkspaceGraph(
  workspaceId: string,
  query: string,
  topK: number = 5,
): Promise<WorkspaceGraphSearchResult[]> {
  const pool = getPool();

  const embedding = await generateEmbedding(query).catch(() => null);
  if (!embedding) return [];

  const { rows } = await pool.query<{
    id: string;
    name: string;
    description: string;
    type: string;
    score: number;
  }>(
    `SELECT id, name, description, type,
            1 - (embedding <=> $2::vector) AS score
     FROM workspace_graph_entities
     WHERE workspace_id = $1
       AND embedding IS NOT NULL
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [workspaceId, `[${embedding.join(",")}]`, topK],
  );

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    score: r.score,
  }));
}
