import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { runMemoryDeduplication } from "./dedup.js";

const log = createLogger("memory-portable");

export interface MemoryBundle {
  workspaceId: string;
  exportedAt: string;
  dailyMemory: unknown[];
  graphEntities: unknown[];
  graphRelations: unknown[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export async function exportWorkspaceMemory(workspaceId: string): Promise<MemoryBundle> {
  const pool = getPool();

  const [daily, entities, relations] = await Promise.all([
    pool.query(
      `SELECT id, user_id, workspace_id, date, entries, updated_at, namespace, access_count, last_accessed_at
       FROM daily_memory WHERE workspace_id::text = $1`,
      [workspaceId],
    ),
    pool.query(
      `SELECT id, uid, type, name, description, properties, confidence, reinforcement_score, access_count, last_accessed_at, created_at, namespace
       FROM graph_entities WHERE uid = ANY(
         SELECT DISTINCT user_id::text FROM daily_memory WHERE workspace_id::text = $1
       )`,
      [workspaceId],
    ),
    pool.query(
      `SELECT gr.id, gr.uid, gr.source_id, gr.target_id, gr.type, gr.weight, gr.metadata, gr.created_at
       FROM graph_edges gr
       WHERE gr.uid = ANY(
         SELECT DISTINCT user_id::text FROM daily_memory WHERE workspace_id::text = $1
       )`,
      [workspaceId],
    ),
  ]);

  return {
    workspaceId,
    exportedAt: new Date().toISOString(),
    dailyMemory: daily.rows,
    graphEntities: entities.rows,
    graphRelations: relations.rows,
  };
}

export async function importMemoryBundle(workspaceId: string, bundle: MemoryBundle): Promise<ImportResult> {
  const pool = getPool();
  let imported = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of bundle.dailyMemory) {
    const r = row as Record<string, unknown>;
    try {
      await pool.query(
        `INSERT INTO daily_memory (id, user_id, workspace_id, date, entries, updated_at)
         VALUES ($1, $2, $3::uuid, $4::date, $5::jsonb, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          r.id,
          r.user_id,
          workspaceId,
          r.date,
          typeof r.entries === "string" ? r.entries : JSON.stringify(r.entries ?? []),
          r.updated_at ?? new Date().toISOString(),
        ],
      );
      imported++;
    } catch (err) {
      skipped++;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`daily_memory ${String(r.id)}: ${msg}`);
      log.dim(`Skipped daily_memory row ${String(r.id)}: ${msg}`);
    }
  }

  // Fire-and-forget deduplication after import to consolidate near-duplicate entries
  if (imported > 0) {
    const importedUids = new Set<string>();
    for (const row of bundle.dailyMemory) {
      const r = row as Record<string, unknown>;
      if (typeof r.user_id === "string") importedUids.add(r.user_id);
    }
    for (const uid of importedUids) {
      runMemoryDeduplication(uid).catch(() => {});
    }
  }

  return { imported, skipped, errors };
}
