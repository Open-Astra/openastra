// ── Semantic Memory Clustering ─────────────────────────────────────────
// Group related memories via k-means centroid vectors.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-clustering");

export interface MemoryCluster {
  id: string;
  workspaceId: string;
  label: string;
  description: string | null;
  memberCount: number;
  status: "active" | "stale" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

export interface ClusterMember {
  id: string;
  clusterId: string;
  memoryId: string;
  memoryTable: string;
  similarity: number;
  addedAt: Date;
}

export async function createCluster(
  workspaceId: string,
  label: string,
  centroidVector: number[],
  description?: string,
): Promise<MemoryCluster> {
  const id = randomUUID();
  const vectorLiteral = `[${centroidVector.join(",")}]`;
  const { rows } = await getPool().query<MemoryCluster>(
    `INSERT INTO memory_clusters (id, workspace_id, label, description, centroid)
     VALUES ($1, $2, $3, $4, $5::vector)
     RETURNING id, workspace_id AS "workspaceId", label, description,
               member_count AS "memberCount", status,
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [id, workspaceId, label, description ?? null, vectorLiteral],
  );
  return rows[0]!;
}

export async function listClusters(workspaceId: string): Promise<MemoryCluster[]> {
  const { rows } = await getPool().query<MemoryCluster>(
    `SELECT id, workspace_id AS "workspaceId", label, description,
            member_count AS "memberCount", status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM memory_clusters WHERE workspace_id = $1 AND status != 'archived'
     ORDER BY member_count DESC, created_at DESC`,
    [workspaceId],
  );
  return rows;
}

export async function getCluster(id: string, workspaceId: string): Promise<MemoryCluster | null> {
  const { rows } = await getPool().query<MemoryCluster>(
    `SELECT id, workspace_id AS "workspaceId", label, description,
            member_count AS "memberCount", status,
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM memory_clusters WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function addClusterMember(
  clusterId: string,
  memoryId: string,
  memoryTable: string,
  similarity: number,
): Promise<void> {
  await getPool().query(
    `INSERT INTO memory_cluster_members (id, cluster_id, memory_id, memory_table, similarity)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (cluster_id, memory_id, memory_table) DO UPDATE
       SET similarity = EXCLUDED.similarity`,
    [randomUUID(), clusterId, memoryId, memoryTable, similarity],
  );
  // Update member count
  await getPool().query(
    `UPDATE memory_clusters SET member_count = (
       SELECT COUNT(*) FROM memory_cluster_members WHERE cluster_id = $1
     ), updated_at = NOW() WHERE id = $1`,
    [clusterId],
  );
}

export async function getClusterMembers(
  clusterId: string,
  workspaceId: string,
): Promise<ClusterMember[]> {
  const { rows } = await getPool().query<ClusterMember>(
    `SELECT cm.id, cm.cluster_id AS "clusterId", cm.memory_id AS "memoryId",
            cm.memory_table AS "memoryTable", cm.similarity, cm.added_at AS "addedAt"
     FROM memory_cluster_members cm
     JOIN memory_clusters mc ON mc.id = cm.cluster_id
     WHERE cm.cluster_id = $1 AND mc.workspace_id = $2
     ORDER BY cm.similarity DESC`,
    [clusterId, workspaceId],
  );
  return rows;
}

export async function archiveCluster(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `UPDATE memory_clusters SET status = 'archived', updated_at = NOW()
     WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

logger.info("Memory clustering module loaded");
