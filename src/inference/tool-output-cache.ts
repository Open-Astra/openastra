// ── Tool Output Cache ────────────────────────────────────────────────
// Caches deterministic tool results by SHA-256 of (toolName + sortedParams).

import { createHash } from "node:crypto";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("tool-output-cache");

const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

function sortedParamsHash(toolName: string, params: unknown): string {
  const sorted = JSON.stringify(params, Object.keys(params as Record<string, unknown>).sort());
  return createHash("sha256").update(`${toolName}:${sorted}`).digest("hex");
}

export async function getCachedToolResult(
  toolName: string,
  params: unknown,
): Promise<unknown | null> {
  const pool = getPool();
  const key = sortedParamsHash(toolName, params);

  const { rows } = await pool.query<{ result: unknown }>(
    `UPDATE tool_output_cache
     SET hit_count = hit_count + 1, last_hit_at = NOW()
     WHERE cache_key = $1 AND expires_at > NOW()
     RETURNING result`,
    [key],
  );

  if (rows.length === 0) {
    // Record miss (best-effort)
    pool.query(
      `INSERT INTO tool_cache_events (tool_name, event_type) VALUES ($1, 'miss')`,
      [toolName],
    ).catch(() => {});
    return null;
  }

  // Record hit (best-effort)
  pool.query(
    `INSERT INTO tool_cache_events (tool_name, event_type) VALUES ($1, 'hit')`,
    [toolName],
  ).catch(() => {});

  return rows[0]!.result;
}

export async function cacheToolResult(
  toolName: string,
  params: unknown,
  result: unknown,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const pool = getPool();
  const key = sortedParamsHash(toolName, params);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await pool.query(
    `INSERT INTO tool_output_cache (cache_key, tool_name, result, expires_at)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (cache_key) DO UPDATE
       SET result = EXCLUDED.result, expires_at = EXCLUDED.expires_at`,
    [key, toolName, JSON.stringify(result), expiresAt],
  );
}

export async function invalidateToolCache(toolName: string): Promise<number> {
  const pool = getPool();
  const { rowCount } = await pool.query(
    `DELETE FROM tool_output_cache WHERE tool_name = $1`,
    [toolName],
  );
  const count = rowCount ?? 0;
  logger.info(`Invalidated ${count} cache entries for tool "${toolName}"`);
  return count;
}

export interface ToolCacheStats {
  totalEntries: number;
  hitCount: number;
  missCount: number;
  oldestEntry: Date | null;
}

export async function getToolCacheStats(): Promise<ToolCacheStats> {
  const pool = getPool();

  const [entriesResult, statsResult] = await Promise.all([
    pool.query<{ total: string; oldest: string | null }>(
      `SELECT COUNT(*) AS total, MIN(created_at) AS oldest FROM tool_output_cache WHERE expires_at > NOW()`,
    ),
    pool.query<{ hits: string; misses: string }>(
      `SELECT
         SUM(CASE WHEN event_type = 'hit'  THEN 1 ELSE 0 END) AS hits,
         SUM(CASE WHEN event_type = 'miss' THEN 1 ELSE 0 END) AS misses
       FROM tool_cache_events
       WHERE recorded_at > NOW() - INTERVAL '24 hours'`,
    ),
  ]);

  return {
    totalEntries: parseInt(entriesResult.rows[0]?.total ?? "0", 10),
    hitCount: parseInt(statsResult.rows[0]?.hits ?? "0", 10),
    missCount: parseInt(statsResult.rows[0]?.misses ?? "0", 10),
    oldestEntry: entriesResult.rows[0]?.oldest ? new Date(entriesResult.rows[0].oldest) : null,
  };
}
