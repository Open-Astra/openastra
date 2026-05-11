import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("budget-limiter");

// Default max bytes per workspace in semantic cache (approximate, based on content length)
const DEFAULT_BUDGET_BYTES = 50 * 1024 * 1024; // 50 MB

// workspace_id → custom budget override
const budgetOverrides = new Map<string, number>();

export function setBudgetOverride(workspaceId: string, bytes: number): void {
  budgetOverrides.set(workspaceId, bytes);
}

/**
 * Check if a workspace is over budget and evict LRU entries if so.
 * Call this lazily after writes (fire-and-forget from setSemanticCache).
 */
export async function enforceCacheBudget(workspaceId: string): Promise<void> {
  const budget = budgetOverrides.get(workspaceId) ?? DEFAULT_BUDGET_BYTES;

  try {
    const pool = getPool();

    // Estimate current usage: sum of content text length as a proxy for bytes
    const usageResult = await pool.query<{ total_bytes: string; entry_count: string }>(
      `SELECT
         COALESCE(SUM(length(content)), 0) AS total_bytes,
         COUNT(*) AS entry_count
       FROM semantic_cache
       WHERE agent_id IN (
         SELECT id FROM agent_configs WHERE workspace_id = $1
       )
         AND expires_at > NOW()`,
      [workspaceId],
    );

    const { total_bytes } = usageResult.rows[0]!;
    const totalBytes = Number(total_bytes);

    if (totalBytes <= budget) return;

    log.info(`Workspace ${workspaceId}: ${Math.round(totalBytes / 1024)}KB used > ${Math.round(budget / 1024)}KB budget — evicting LRU entries`);

    // Evict oldest entries until we're under target
    await pool.query(
      `DELETE FROM semantic_cache
       WHERE id IN (
         SELECT sc.id
         FROM semantic_cache sc
         JOIN agent_configs ac ON ac.id = sc.agent_id
         WHERE ac.workspace_id = $1
           AND sc.expires_at > NOW()
         ORDER BY sc.created_at ASC
         LIMIT (
           SELECT COUNT(*) / 4 + 1
           FROM semantic_cache sc2
           JOIN agent_configs ac2 ON ac2.id = sc2.agent_id
           WHERE ac2.workspace_id = $1 AND sc2.expires_at > NOW()
         )
       )`,
      [workspaceId],
    );

    log.dim(`Evicted LRU entries for workspace ${workspaceId}`);
  } catch (err) {
    log.warn(`Budget enforcement error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function getBudgetConfig(workspaceId: string): { budget: number; override: boolean } {
  const override = budgetOverrides.get(workspaceId);
  return {
    budget: override ?? DEFAULT_BUDGET_BYTES,
    override: override !== undefined,
  };
}
