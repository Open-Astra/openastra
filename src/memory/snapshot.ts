import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Memory Snapshots ──────────────────────────────────────────────────
// Point-in-time captures of a user's full memory state (daily + graph).
// Stored in the memory_snapshots table (migration 070).

const log = createLogger("memory-snapshot");

export interface Snapshot {
  id: string;
  workspaceId: string;
  uid: string;
  snapshotType: string;
  label: string | null;
  createdAt: string;
}

interface SnapshotRow {
  id: string;
  workspace_id: string;
  uid: string;
  snapshot_type: string;
  label: string | null;
  created_at: string;
}

function rowToSnapshot(row: SnapshotRow): Snapshot {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    uid: row.uid,
    snapshotType: row.snapshot_type,
    label: row.label,
    createdAt: row.created_at,
  };
}

/**
 * Capture all daily_memory rows + graph_entities for the given uid/workspace
 * and store them as a JSONB blob in memory_snapshots.
 * Returns the new snapshotId.
 */
export async function createMemorySnapshot(
  workspaceId: string,
  uid: string,
  label?: string,
  pool?: Pool,
): Promise<string> {
  const db = pool ?? getPool();
  const snapshotId = randomUUID();
  const snapshotType = "manual";

  // Collect daily_memory + graph_entities + graph_edges
  const [daily, entities, edges] = await Promise.all([
    db.query(
      `SELECT id, user_id, date, entries, updated_at, namespace
       FROM daily_memory
       WHERE user_id = $1 AND workspace_id::text = $2`,
      [uid, workspaceId],
    ),
    db.query(
      `SELECT id, uid, type, name, description, properties, confidence, reinforcement_score,
              access_count, last_accessed_at, created_at
       FROM graph_entities
       WHERE uid = $1`,
      [uid],
    ),
    db.query(
      `SELECT id, uid, source_id, target_id, type, weight, metadata, created_at
       FROM graph_edges
       WHERE uid = $1`,
      [uid],
    ),
  ]);

  const memoryData = {
    capturedAt: new Date().toISOString(),
    uid,
    workspaceId,
    dailyMemory: daily.rows,
    graphEntities: entities.rows,
    graphEdges: edges.rows,
  };

  await db.query(
    `INSERT INTO memory_snapshots (id, workspace_id, uid, snapshot_type, memory_data, label)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [snapshotId, workspaceId, uid, snapshotType, JSON.stringify(memoryData), label ?? null],
  );

  log.info(`Created memory snapshot ${snapshotId} for uid=${uid}`);
  return snapshotId;
}

/**
 * Restore a snapshot: re-insert daily_memory rows + graph_entities from the
 * snapshot blob using ON CONFLICT DO NOTHING (non-destructive).
 */
export async function restoreMemorySnapshot(
  snapshotId: string,
  workspaceId: string,
  uid: string,
  pool?: Pool,
): Promise<void> {
  const db = pool ?? getPool();

  const { rows } = await db.query<{ memory_data: Record<string, unknown>; workspace_id: string; uid: string }>(
    `SELECT memory_data, workspace_id, uid FROM memory_snapshots WHERE id = $1`,
    [snapshotId],
  );

  if (rows.length === 0) {
    throw new Error(`Snapshot ${snapshotId} not found`);
  }

  const row = rows[0]!;
  if (row.workspace_id !== workspaceId || row.uid !== uid) {
    throw new Error("Snapshot does not belong to the requesting workspace/user");
  }

  const data = row.memory_data as {
    dailyMemory?: Array<Record<string, unknown>>;
    graphEntities?: Array<Record<string, unknown>>;
    graphEdges?: Array<Record<string, unknown>>;
  };

  for (const dm of data.dailyMemory ?? []) {
    await db
      .query(
        `INSERT INTO daily_memory (id, user_id, workspace_id, date, entries, updated_at, namespace)
         VALUES ($1, $2, $3::uuid, $4::date, $5::jsonb, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          dm.id,
          dm.user_id,
          workspaceId,
          dm.date,
          typeof dm.entries === "string" ? dm.entries : JSON.stringify(dm.entries ?? []),
          dm.updated_at ?? new Date().toISOString(),
          dm.namespace ?? "default",
        ],
      )
      .catch(() => {});
  }

  for (const ge of data.graphEntities ?? []) {
    await db
      .query(
        `INSERT INTO graph_entities
           (id, uid, type, name, description, properties, confidence, reinforcement_score,
            access_count, last_accessed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO NOTHING`,
        [
          ge.id,
          ge.uid,
          ge.type,
          ge.name,
          ge.description ?? "",
          typeof ge.properties === "string" ? ge.properties : JSON.stringify(ge.properties ?? {}),
          ge.confidence ?? 1.0,
          ge.reinforcement_score ?? 1.0,
          ge.access_count ?? 0,
          ge.last_accessed_at ?? null,
          ge.created_at ?? new Date().toISOString(),
        ],
      )
      .catch(() => {});
  }

  for (const edge of data.graphEdges ?? []) {
    await db
      .query(
        `INSERT INTO graph_edges (id, uid, source_id, target_id, type, weight, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          edge.id,
          edge.uid,
          edge.source_id,
          edge.target_id,
          edge.type,
          edge.weight ?? 1.0,
          typeof edge.metadata === "string" ? edge.metadata : JSON.stringify(edge.metadata ?? {}),
          edge.created_at ?? new Date().toISOString(),
        ],
      )
      .catch(() => {});
  }

  log.info(`Restored snapshot ${snapshotId} for uid=${uid}`);
}

/**
 * List snapshots for a given workspace/uid, newest first.
 */
export async function listSnapshots(
  workspaceId: string,
  uid: string,
  pool?: Pool,
): Promise<Snapshot[]> {
  const db = pool ?? getPool();

  const { rows } = await db.query<SnapshotRow>(
    `SELECT id, workspace_id, uid, snapshot_type, label, created_at
     FROM memory_snapshots
     WHERE workspace_id = $1 AND uid = $2
     ORDER BY created_at DESC
     LIMIT 100`,
    [workspaceId, uid],
  );

  return rows.map(rowToSnapshot);
}
