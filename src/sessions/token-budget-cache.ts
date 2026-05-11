import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("token-budget");

interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  lastFlushedAt: number;
  dirty: boolean;
}

const budgetCache = new Map<string, TokenUsage>();
const FLUSH_INTERVAL_MS = 30_000; // Flush to DB every 30s

/**
 * Record tokens used in a turn. Accumulates in-memory and flushes periodically.
 */
export function recordTokenUsage(
  sessionId: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
): void {
  const existing = budgetCache.get(sessionId) ?? {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    lastFlushedAt: Date.now(),
    dirty: false,
  };

  existing.promptTokens += usage.promptTokens;
  existing.completionTokens += usage.completionTokens;
  existing.cachedTokens += usage.cachedTokens ?? 0;
  existing.dirty = true;

  budgetCache.set(sessionId, existing);
}

/** Get cached usage for a session without hitting DB. */
export function getSessionTokenUsage(sessionId: string): TokenUsage | undefined {
  return budgetCache.get(sessionId);
}

/** Flush a single session's token usage to the DB. */
export async function flushSessionTokens(sessionId: string): Promise<void> {
  const usage = budgetCache.get(sessionId);
  if (!usage || !usage.dirty) return;

  try {
    const pool = getPool();
    await pool.query(
      `UPDATE sessions
       SET token_count = token_count + $1,
           updated_at = NOW()
       WHERE id = $2`,
      [usage.promptTokens + usage.completionTokens, sessionId],
    );
    usage.dirty = false;
    usage.lastFlushedAt = Date.now();
    log.dim(`Flushed token usage for session ${sessionId}`);
  } catch (err) {
    log.warn(`Token flush failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Remove session from cache (call after session ends). */
export async function evictSessionTokenCache(sessionId: string): Promise<void> {
  await flushSessionTokens(sessionId);
  budgetCache.delete(sessionId);
}

// Periodic flush every 30s (unref'd)
const flushInterval = setInterval(async () => {
  const now = Date.now();
  for (const [sessionId, usage] of budgetCache) {
    if (usage.dirty && now - usage.lastFlushedAt >= FLUSH_INTERVAL_MS) {
      await flushSessionTokens(sessionId).catch(() => {});
    }
  }
}, FLUSH_INTERVAL_MS);
if (flushInterval.unref) flushInterval.unref();
