// ── Associative Memory Retrieval ─────────────────────────
// Graph-walk retrieval: follow associations between memories across tiers.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-associative-retrieval");

export type AssociationType =
  | "related" | "derived" | "contradicts" | "supports" | "temporal_sequence" | "causal";

export interface Association {
  id: string;
  workspaceId: string;
  sourceMemoryId: string;
  sourceTier: string;
  targetMemoryId: string;
  targetTier: string;
  associationType: AssociationType;
  strength: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AssociationEdge { source: string; target: string; type: AssociationType; strength: number; }
export interface AssociationGraph { nodes: string[]; edges: AssociationEdge[]; }
export interface AssociativeRetrievalResult { memoryId: string; tier: string; score: number; hops: number; }
export interface GetAssociationsOptions { type?: AssociationType; minStrength?: number; limit?: number; }
export interface AssociativeRetrieveOptions { maxHops?: number; minStrength?: number; limit?: number; types?: AssociationType[]; }

export async function createAssociation(
  workspaceId: string, sourceId: string, sourceTier: string,
  targetId: string, targetTier: string, type: AssociationType,
  strength = 0.5, metadata: Record<string, unknown> = {},
): Promise<Association> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO memory_associations
       (workspace_id, source_memory_id, source_tier, target_memory_id, target_tier, association_type, strength, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, source_memory_id, target_memory_id)
     DO UPDATE SET association_type = EXCLUDED.association_type,
       strength = EXCLUDED.strength, metadata = EXCLUDED.metadata
     RETURNING *`,
    [workspaceId, sourceId, sourceTier, targetId, targetTier, type, strength, JSON.stringify(metadata)],
  );
  logger.info(`Created association ${result.rows[0].id}`);
  return mapRow(result.rows[0]);
}

export async function getAssociations(
  workspaceId: string, memoryId: string, options: GetAssociationsOptions = {},
): Promise<Association[]> {
  const pool = getPool();
  const conditions = ["workspace_id = $1", "(source_memory_id = $2 OR target_memory_id = $2)"];
  const params: unknown[] = [workspaceId, memoryId];
  let idx = 3;
  if (options.type) { conditions.push(`association_type = $${idx}`); params.push(options.type); idx++; }
  if (options.minStrength !== undefined) { conditions.push(`strength >= $${idx}`); params.push(options.minStrength); idx++; }
  const limit = options.limit ?? 100;
  params.push(limit);
  const result = await pool.query(
    `SELECT * FROM memory_associations WHERE ${conditions.join(" AND ")} ORDER BY strength DESC LIMIT $${idx}`, params);
  return result.rows.map(mapRow);
}

export async function associativeRetrieve(
  workspaceId: string, seedMemoryIds: string[], options: AssociativeRetrieveOptions = {},
): Promise<AssociativeRetrievalResult[]> {
  const pool = getPool();
  const maxHops = options.maxHops ?? 2;
  const minStrength = options.minStrength ?? 0.1;
  const limit = options.limit ?? 50;
  const decayPerHop = 0.8;
  if (seedMemoryIds.length === 0) return [];
  const typeFilter = options.types && options.types.length > 0 ? "AND a.association_type = ANY($4)" : "";
  const params: unknown[] = [workspaceId, seedMemoryIds, minStrength];
  if (options.types && options.types.length > 0) { params.push(options.types); }
  const result = await pool.query(
    `WITH RECURSIVE assoc_walk AS (
       SELECT unnest($2::text[]) AS memory_id, '' AS tier, 1.0::real AS score, 0 AS hops
       UNION ALL
       SELECT
         CASE WHEN a.source_memory_id = w.memory_id THEN a.target_memory_id ELSE a.source_memory_id END,
         CASE WHEN a.source_memory_id = w.memory_id THEN a.target_tier ELSE a.source_tier END,
         (w.score * a.strength * ${decayPerHop})::real, w.hops + 1
       FROM assoc_walk w JOIN memory_associations a ON a.workspace_id = $1
         AND (a.source_memory_id = w.memory_id OR a.target_memory_id = w.memory_id)
         AND a.strength >= $3 ${typeFilter}
       WHERE w.hops < ${maxHops}
     ) SELECT memory_id, tier, MAX(score) AS score, MIN(hops) AS hops
     FROM assoc_walk WHERE hops > 0
     GROUP BY memory_id, tier ORDER BY score DESC LIMIT ${limit}`, params);
  return result.rows.map((r: Record<string, unknown>) => ({
    memoryId: r.memory_id as string, tier: r.tier as string,
    score: r.score as number, hops: r.hops as number,
  }));
}

export async function strengthenAssociation(
  workspaceId: string, sourceId: string, targetId: string, delta: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE memory_associations SET strength = LEAST(1.0, strength + $4)
     WHERE workspace_id = $1 AND source_memory_id = $2 AND target_memory_id = $3`,
    [workspaceId, sourceId, targetId, delta]);
  logger.info(`Strengthened ${sourceId} -> ${targetId} by ${delta}`);
}

export async function weakenAssociation(
  workspaceId: string, sourceId: string, targetId: string, delta: number,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE memory_associations SET strength = GREATEST(0.0, strength - $4)
     WHERE workspace_id = $1 AND source_memory_id = $2 AND target_memory_id = $3`,
    [workspaceId, sourceId, targetId, delta]);
  await pool.query(
    `DELETE FROM memory_associations WHERE workspace_id = $1
     AND source_memory_id = $2 AND target_memory_id = $3 AND strength < 0.05`,
    [workspaceId, sourceId, targetId]);
  logger.info(`Weakened ${sourceId} -> ${targetId} by ${delta}`);
}

export async function getAssociationGraph(
  workspaceId: string, centerId: string, depth: number,
): Promise<AssociationGraph> {
  const pool = getPool();
  const result = await pool.query(
    `WITH RECURSIVE graph_walk AS (
       SELECT source_memory_id, target_memory_id, association_type, strength, 0 AS hop
       FROM memory_associations
       WHERE workspace_id = $1 AND (source_memory_id = $2 OR target_memory_id = $2)
       UNION
       SELECT a.source_memory_id, a.target_memory_id, a.association_type, a.strength, g.hop + 1
       FROM graph_walk g JOIN memory_associations a ON a.workspace_id = $1
         AND (a.source_memory_id IN (g.source_memory_id, g.target_memory_id)
              OR a.target_memory_id IN (g.source_memory_id, g.target_memory_id))
       WHERE g.hop < $3
     ) SELECT DISTINCT source_memory_id, target_memory_id, association_type, strength
     FROM graph_walk`, [workspaceId, centerId, depth]);
  const nodeSet = new Set<string>();
  const edges: AssociationEdge[] = [];
  for (const row of result.rows) {
    const r = row as Record<string, unknown>;
    nodeSet.add(r.source_memory_id as string);
    nodeSet.add(r.target_memory_id as string);
    edges.push({ source: r.source_memory_id as string, target: r.target_memory_id as string,
      type: r.association_type as AssociationType, strength: r.strength as number });
  }
  return { nodes: Array.from(nodeSet), edges };
}

export async function autoAssociate(
  workspaceId: string, newMemoryId: string, tier: string,
): Promise<Association[]> {
  const pool = getPool();
  const created: Association[] = [];
  const recent = await pool.query(
    `SELECT DISTINCT source_memory_id AS mid, source_tier AS t FROM memory_associations
     WHERE workspace_id = $1 AND source_tier = $2 AND source_memory_id != $3
     AND created_at > NOW() - INTERVAL '7 days' ORDER BY source_memory_id LIMIT 5`,
    [workspaceId, tier, newMemoryId]);
  for (const row of recent.rows) {
    const r = row as Record<string, unknown>;
    const a = await createAssociation(workspaceId, newMemoryId, tier,
      r.mid as string, r.t as string, "related", 0.3);
    created.push(a);
  }
  logger.info(`Auto-associated ${newMemoryId}: ${created.length} new`);
  return created;
}

export async function deleteAssociation(
  workspaceId: string, sourceId: string, targetId: string,
): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `DELETE FROM memory_associations WHERE workspace_id = $1
     AND source_memory_id = $2 AND target_memory_id = $3`,
    [workspaceId, sourceId, targetId]);
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) logger.info(`Deleted association ${sourceId} -> ${targetId}`);
  return deleted;
}

export async function deleteAssociationById(workspaceId: string, id: string): Promise<boolean> {
  const pool = getPool();
  const r = await pool.query("DELETE FROM memory_associations WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  return (r.rowCount ?? 0) > 0;
}

export async function getAssociationById(workspaceId: string, id: string): Promise<Association | null> {
  const pool = getPool();
  const r = await pool.query("SELECT * FROM memory_associations WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  if (r.rows.length === 0) return null;
  return mapRow(r.rows[0]);
}

function mapRow(row: Record<string, unknown>): Association {
  return {
    id: row.id as string, workspaceId: row.workspace_id as string,
    sourceMemoryId: row.source_memory_id as string, sourceTier: row.source_tier as string,
    targetMemoryId: row.target_memory_id as string, targetTier: row.target_tier as string,
    associationType: row.association_type as AssociationType, strength: row.strength as number,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
  };
}
