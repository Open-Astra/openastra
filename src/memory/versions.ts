// ── Memory Versioning ──────────────────────────────────────────────────
// Immutable content snapshots for daily_memory / graph_entities.
// Allows rollback to any prior version.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-versions");

export interface MemoryVersion {
  id: string;
  workspaceId: string;
  memoryId: string;
  memoryTable: string;
  version: number;
  content: unknown;
  editedBy: string | null;
  createdAt: Date;
}

export async function snapshotVersion(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  content: unknown,
  editedBy?: string,
): Promise<MemoryVersion> {
  const id = randomUUID();
  const { rows } = await getPool().query<MemoryVersion>(
    `INSERT INTO memory_versions
       (id, workspace_id, memory_id, memory_table, version, content, edited_by)
     VALUES (
       $1, $2, $3, $4,
       COALESCE(
         (SELECT MAX(version) FROM memory_versions
          WHERE workspace_id = $2 AND memory_id = $3 AND memory_table = $4),
         0
       ) + 1,
       $5::jsonb, $6
     )
     RETURNING id, workspace_id AS "workspaceId", memory_id AS "memoryId",
               memory_table AS "memoryTable", version, content,
               edited_by AS "editedBy", created_at AS "createdAt"`,
    [id, workspaceId, memoryId, memoryTable, JSON.stringify(content), editedBy ?? null],
  );
  return rows[0]!;
}

export async function listVersions(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
): Promise<Omit<MemoryVersion, "content">[]> {
  const { rows } = await getPool().query(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", version,
            edited_by AS "editedBy", created_at AS "createdAt"
     FROM memory_versions
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
     ORDER BY version DESC`,
    [workspaceId, memoryId, memoryTable],
  );
  return rows as Omit<MemoryVersion, "content">[];
}

export async function getVersion(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  version: number,
): Promise<MemoryVersion | null> {
  const { rows } = await getPool().query<MemoryVersion>(
    `SELECT id, workspace_id AS "workspaceId", memory_id AS "memoryId",
            memory_table AS "memoryTable", version, content,
            edited_by AS "editedBy", created_at AS "createdAt"
     FROM memory_versions
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3 AND version = $4`,
    [workspaceId, memoryId, memoryTable, version],
  );
  return rows[0] ?? null;
}

export async function purgeOldVersions(
  workspaceId: string,
  memoryId: string,
  memoryTable: string,
  keepLatest = 10,
): Promise<number> {
  const { rowCount } = await getPool().query(
    `DELETE FROM memory_versions
     WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
       AND version NOT IN (
         SELECT version FROM memory_versions
         WHERE workspace_id = $1 AND memory_id = $2 AND memory_table = $3
         ORDER BY version DESC LIMIT $4
       )`,
    [workspaceId, memoryId, memoryTable, keepLatest],
  );
  const deleted = rowCount ?? 0;
  if (deleted > 0) logger.info(`Purged ${deleted} old versions for ${memoryTable}/${memoryId}`);
  return deleted;
}

logger.info("Memory versioning module loaded");
