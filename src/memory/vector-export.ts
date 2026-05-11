// ── Vector DB Export ───────────────────────────────────────────────────
// Export memory embeddings to Pinecone / Weaviate / Qdrant.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("vector-export");

export type VectorExportTarget = "pinecone" | "weaviate" | "qdrant";

export interface VectorExportJob {
  id: string;
  workspaceId: string;
  target: VectorExportTarget;
  targetConfig: Record<string, unknown>;
  status: "pending" | "running" | "done" | "failed";
  recordsExported: number;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export async function createExportJob(
  workspaceId: string,
  target: VectorExportTarget,
  targetConfig: Record<string, unknown>,
): Promise<VectorExportJob> {
  const id = randomUUID();
  const { rows } = await getPool().query<VectorExportJob>(
    `INSERT INTO vector_export_jobs
       (id, workspace_id, target, target_config)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, workspace_id AS "workspaceId", target,
               target_config AS "targetConfig", status,
               records_exported AS "recordsExported", error_message AS "errorMessage",
               started_at AS "startedAt", finished_at AS "finishedAt",
               created_at AS "createdAt"`,
    [id, workspaceId, target, JSON.stringify(targetConfig)],
  );
  logger.info(`Vector export job created: ${id} → ${target}`);
  return rows[0]!;
}

export async function listExportJobs(workspaceId: string, limit = 20): Promise<VectorExportJob[]> {
  const { rows } = await getPool().query<VectorExportJob>(
    `SELECT id, workspace_id AS "workspaceId", target,
            target_config AS "targetConfig", status,
            records_exported AS "recordsExported", error_message AS "errorMessage",
            started_at AS "startedAt", finished_at AS "finishedAt",
            created_at AS "createdAt"
     FROM vector_export_jobs WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}

export async function getExportJob(
  id: string,
  workspaceId: string,
): Promise<VectorExportJob | null> {
  const { rows } = await getPool().query<VectorExportJob>(
    `SELECT id, workspace_id AS "workspaceId", target,
            target_config AS "targetConfig", status,
            records_exported AS "recordsExported", error_message AS "errorMessage",
            started_at AS "startedAt", finished_at AS "finishedAt",
            created_at AS "createdAt"
     FROM vector_export_jobs WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return rows[0] ?? null;
}

export async function updateExportJob(
  id: string,
  status: VectorExportJob["status"],
  opts: { recordsExported?: number; errorMessage?: string } = {},
): Promise<void> {
  await getPool().query(
    `UPDATE vector_export_jobs
     SET status = $2,
         records_exported = COALESCE($3, records_exported),
         error_message = $4,
         started_at = CASE WHEN $2 = 'running' THEN NOW() ELSE started_at END,
         finished_at = CASE WHEN $2 IN ('done', 'failed') THEN NOW() ELSE finished_at END,
         updated_at = NOW()
     WHERE id = $1`,
    [id, status, opts.recordsExported ?? null, opts.errorMessage ?? null],
  );
}

/** Fetch raw embeddings from daily_memory for export (batch). */
export async function fetchMemoryEmbeddings(
  workspaceId: string,
  limit = 1000,
  offset = 0,
): Promise<Array<{ id: string; content: string; category: string; embedding: number[] | null }>> {
  const { rows } = await getPool().query(
    `SELECT id, content, category,
            embedding::text AS embedding
     FROM daily_memory
     WHERE workspace_id = $1 AND embedding IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [workspaceId, limit, offset],
  );
  return (rows as Array<{ id: string; content: string; category: string; embedding: string }>).map(
    (r) => ({
      ...r,
      embedding: r.embedding
        ? (JSON.parse(r.embedding) as number[])
        : null,
    }),
  );
}

logger.info("Vector export module loaded");
