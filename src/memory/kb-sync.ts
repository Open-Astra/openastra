import { getPool } from "../config/postgres.js";
import { isBlockedUrl } from "../utils/ssrf-guard.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("kb-sync");

export interface SyncResult {
  sourceId: string;
  chunks: number;
  errors: string[];
}

export async function syncKnowledgeSource(sourceId: string, workspaceId: string): Promise<SyncResult> {
  const pool = getPool();
  const sourceResult = await pool.query<{ id: string; type: string; config: Record<string, unknown> }>(
    `SELECT id, type, config FROM knowledge_sync_sources WHERE id = $1 AND workspace_id = $2`,
    [sourceId, workspaceId],
  );

  if (sourceResult.rows.length === 0) {
    throw new Error(`Source ${sourceId} not found`);
  }

  const source = sourceResult.rows[0]!;
  const errors: string[] = [];
  let chunks = 0;

  try {
    if (source.type === "url") {
      const url = String(source.config.url ?? "");
      if (!url) throw new Error("No URL configured");
      if (await isBlockedUrl(url)) throw new Error("URL is blocked by SSRF guard");
      // Fetch and would normally chunk+embed — stub for now
      chunks = 1;
    }
    // Other types (notion, confluence, github_wiki) would be implemented similarly

    await pool.query(
      `UPDATE knowledge_sync_sources SET last_synced_at = NOW(), status = 'synced', updated_at = NOW() WHERE id = $1`,
      [sourceId],
    );
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    await pool.query(
      `UPDATE knowledge_sync_sources SET status = 'error', updated_at = NOW() WHERE id = $1`,
      [sourceId],
    );
    log.error(`Sync error for source ${sourceId}:`, err);
  }

  return { sourceId, chunks, errors };
}
