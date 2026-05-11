// ── Memory Pinning ───────────────────────────────────────────────────
// Mark specific memory entries as permanent (exempt from TTL / pruning).

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-pinning");

export type MemoryTier = "daily";

export interface PinnedMemory {
  id: string;
  tier: MemoryTier;
  userId: string;
  date: string;
  pinnedAt: Date;
}

/**
 * Pin a daily_memory row so it survives TTL and pruning.
 * Keyed by (user_id, workspace_id, date) since daily_memory uses a composite PK.
 */
export async function pinDailyMemory(
  userId: string,
  date: string,
  workspaceId: string,
): Promise<void> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE daily_memory
     SET pinned = true, pinned_at = NOW()
     WHERE user_id = $1 AND date = $2 AND workspace_id IS NOT DISTINCT FROM $3`,
    [userId, date, workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`No daily_memory entry found for user=${userId} date=${date}`);
  }
  logger.info(`Pinned daily memory for user=${userId} date=${date}`);
}

export async function unpinDailyMemory(
  userId: string,
  date: string,
  workspaceId: string,
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `UPDATE daily_memory
     SET pinned = false, pinned_at = NULL
     WHERE user_id = $1 AND date = $2 AND workspace_id IS NOT DISTINCT FROM $3`,
    [userId, date, workspaceId],
  );
}

export async function getPinnedMemories(
  userId: string,
  workspaceId: string,
): Promise<PinnedMemory[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    user_id: string;
    date: string;
    pinned_at: Date;
  }>(
    `SELECT user_id, date, pinned_at
     FROM daily_memory
     WHERE user_id = $1 AND workspace_id IS NOT DISTINCT FROM $2 AND pinned = true
     ORDER BY pinned_at DESC`,
    [userId, workspaceId],
  );

  return rows.map((r) => ({
    id: `daily:${r.user_id}:${r.date}`,
    tier: "daily" as MemoryTier,
    userId: r.user_id,
    date: r.date,
    pinnedAt: r.pinned_at,
  }));
}
