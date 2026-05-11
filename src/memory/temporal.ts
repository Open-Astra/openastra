// ── Temporal Memory Queries ────────────────────────────────────────────
// Query memory entries by time range, recency, and temporal relevance.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-temporal");

export interface TemporalMemoryEntry {
  id: string;
  workspaceId: string;
  uid: string;
  category: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
  ageDays: number;
}

export interface TemporalQueryOptions {
  category?: string;
  uid?: string;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
  orderBy?: "newest" | "oldest";
}

export async function queryByTimeRange(
  workspaceId: string,
  opts: TemporalQueryOptions = {},
): Promise<TemporalMemoryEntry[]> {
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (opts.uid) { conditions.push(`uid = $${idx++}`); params.push(opts.uid); }
  if (opts.category) { conditions.push(`category = $${idx++}`); params.push(opts.category); }
  if (opts.fromDate) { conditions.push(`created_at >= $${idx++}`); params.push(opts.fromDate); }
  if (opts.toDate) { conditions.push(`created_at <= $${idx++}`); params.push(opts.toDate); }

  const order = opts.orderBy === "oldest" ? "ASC" : "DESC";
  const limit = opts.limit ?? 50;

  const { rows } = await getPool().query(
    `SELECT id, workspace_id AS "workspaceId", uid, category, content,
            created_at AS "createdAt", updated_at AS "updatedAt",
            EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400 AS "ageDays"
     FROM daily_memory
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at ${order}
     LIMIT $${idx}`,
    [...params, limit],
  );
  return rows as TemporalMemoryEntry[];
}

export async function getMemorySince(
  workspaceId: string,
  uid: string,
  since: Date,
  limit = 100,
): Promise<TemporalMemoryEntry[]> {
  return queryByTimeRange(workspaceId, { uid, fromDate: since, limit, orderBy: "newest" });
}

export async function getRecentMemory(
  workspaceId: string,
  uid: string,
  dayWindow = 7,
  limit = 50,
): Promise<TemporalMemoryEntry[]> {
  const from = new Date();
  from.setDate(from.getDate() - dayWindow);
  return queryByTimeRange(workspaceId, { uid, fromDate: from, limit, orderBy: "newest" });
}

export async function getMemoryTimeline(
  workspaceId: string,
  uid: string,
  bucketBy: "day" | "week" | "month" = "day",
): Promise<Array<{ bucket: string; count: number; categories: string[] }>> {
  const truncUnit = bucketBy === "week" ? "week" : bucketBy === "month" ? "month" : "day";
  const { rows } = await getPool().query(
    `SELECT
       DATE_TRUNC($3, created_at)::text AS bucket,
       COUNT(*) AS count,
       ARRAY_AGG(DISTINCT category) AS categories
     FROM daily_memory
     WHERE workspace_id = $1 AND uid = $2
     GROUP BY DATE_TRUNC($3, created_at)
     ORDER BY bucket DESC
     LIMIT 90`,
    [workspaceId, uid, truncUnit],
  );
  return rows as Array<{ bucket: string; count: number; categories: string[] }>;
}

export async function getEntityTimeline(
  workspaceId: string,
  entityName: string,
  bucketBy: "day" | "week" = "day",
): Promise<Array<{ bucket: string; count: number }>> {
  const truncUnit = bucketBy === "week" ? "week" : "day";
  const { rows } = await getPool().query(
    `SELECT
       DATE_TRUNC($3, created_at)::text AS bucket,
       COUNT(*) AS count
     FROM graph_entities
     WHERE workspace_id = $1 AND name ILIKE $2
     GROUP BY DATE_TRUNC($3, created_at)
     ORDER BY bucket DESC
     LIMIT 90`,
    [workspaceId, `%${entityName}%`, truncUnit],
  );
  return rows as Array<{ bucket: string; count: number }>;
}

logger.info("Memory temporal module loaded");
