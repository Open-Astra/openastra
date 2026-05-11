// ── Knowledge Distillation ─────────────────────────────────────────────
// Compress repeated memory patterns into compact distilled facts.

import { getPool } from "../config/postgres.js";
import { randomUUID } from "node:crypto";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-distillation");

export interface DistilledFact {
  id: string;
  workspaceId: string;
  uid: string;
  fact: string;
  category: string;
  confidence: number;
  sourceCount: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function upsertDistilledFact(
  workspaceId: string,
  uid: string,
  fact: string,
  category: string,
  opts: {
    confidence?: number;
    sourceCount?: number;
    expiresAt?: Date;
  } = {},
): Promise<DistilledFact> {
  const id = randomUUID();
  const { rows } = await getPool().query<DistilledFact>(
    `INSERT INTO distilled_facts
       (id, workspace_id, uid, fact, category, confidence, source_count, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, uid, fact) DO UPDATE
       SET confidence = GREATEST(EXCLUDED.confidence, distilled_facts.confidence),
           source_count = distilled_facts.source_count + EXCLUDED.source_count,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()
     RETURNING id, workspace_id AS "workspaceId", uid, fact, category,
               confidence, source_count AS "sourceCount", expires_at AS "expiresAt",
               created_at AS "createdAt", updated_at AS "updatedAt"`,
    [
      id, workspaceId, uid, fact, category,
      opts.confidence ?? 0.8,
      opts.sourceCount ?? 1,
      opts.expiresAt ?? null,
    ],
  );
  return rows[0]!;
}

export async function listDistilledFacts(
  workspaceId: string,
  uid: string,
  opts: { category?: string; minConfidence?: number; limit?: number } = {},
): Promise<DistilledFact[]> {
  const conditions = ["workspace_id = $1", "uid = $2",
    "(expires_at IS NULL OR expires_at > NOW())"];
  const params: unknown[] = [workspaceId, uid];
  let idx = 3;

  if (opts.category) { conditions.push(`category = $${idx++}`); params.push(opts.category); }
  if (opts.minConfidence !== undefined) {
    conditions.push(`confidence >= $${idx++}`);
    params.push(opts.minConfidence);
  }

  const { rows } = await getPool().query<DistilledFact>(
    `SELECT id, workspace_id AS "workspaceId", uid, fact, category,
            confidence, source_count AS "sourceCount", expires_at AS "expiresAt",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM distilled_facts
     WHERE ${conditions.join(" AND ")}
     ORDER BY confidence DESC, source_count DESC
     LIMIT $${idx}`,
    [...params, opts.limit ?? 50],
  );
  return rows;
}

export async function deleteDistilledFact(id: string, workspaceId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM distilled_facts WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  return (rowCount ?? 0) > 0;
}

export async function purgeExpiredFacts(workspaceId?: string): Promise<number> {
  const { rowCount } = await getPool().query(
    workspaceId
      ? `DELETE FROM distilled_facts WHERE workspace_id = $1 AND expires_at < NOW()`
      : `DELETE FROM distilled_facts WHERE expires_at < NOW()`,
    workspaceId ? [workspaceId] : [],
  );
  const n = rowCount ?? 0;
  if (n > 0) logger.info(`Purged ${n} expired distilled facts`);
  return n;
}

export async function getDistilledFactStats(
  workspaceId: string,
): Promise<Array<{ category: string; count: number; avgConfidence: number }>> {
  const { rows } = await getPool().query(
    `SELECT category, COUNT(*) AS count, AVG(confidence) AS "avgConfidence"
     FROM distilled_facts
     WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > NOW())
     GROUP BY category ORDER BY count DESC`,
    [workspaceId],
  );
  return rows as Array<{ category: string; count: number; avgConfidence: number }>;
}

logger.info("Memory distillation module loaded");
