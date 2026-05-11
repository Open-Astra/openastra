import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("group-tags");

/**
 * Add tags to a cached entry by query text and agent ID.
 * Tags enable bulk invalidation of related cache entries (e.g., all entries for a conversation).
 */
export async function tagCacheEntry(
  queryText: string,
  agentId: string,
  tags: string[],
): Promise<void> {
  if (tags.length === 0) return;

  try {
    const pool = getPool();
    await pool.query(
      `UPDATE semantic_cache
       SET tags = tags || $1::text[]
       WHERE query_text = $2 AND agent_id = $3`,
      [tags, queryText, agentId],
    );
  } catch (err) {
    log.warn(`Failed to tag cache entry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Invalidate all cached entries with a specific tag.
 * Useful for bulk cache eviction (e.g., when a conversation is archived).
 * @returns Number of rows deleted
 */
export async function invalidateCacheGroup(tag: string): Promise<number> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM semantic_cache WHERE $1 = ANY(tags)`,
      [tag],
    );
    log.dim(`Invalidated ${result.rowCount ?? 0} cache entries for tag "${tag}"`);
    return result.rowCount ?? 0;
  } catch (err) {
    log.warn(`Failed to invalidate cache group: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Get the number of cached entries with a specific tag.
 * Useful for monitoring tag usage and cache footprint.
 */
export async function getCacheGroupSize(tag: string): Promise<number> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT COUNT(*) as count FROM semantic_cache WHERE $1 = ANY(tags)`,
      [tag],
    );
    return parseInt((result.rows[0]?.count as string) ?? "0", 10);
  } catch (err) {
    log.warn(`Failed to get cache group size: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
