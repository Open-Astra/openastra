import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";

// ── Session Memory Prefetch ─────────────────────────────────────────
// Pre-warms memory caches for a user at session start.
// Called by the context assembler before the first inference round.
//
// Queries Postgres for the user's most recently accessed/created memories
// across Tier 2 (daily notes) and Tier 4 (graph entities), then stores
// compact summaries in an in-memory prefetch store keyed by uid:sessionId.
// This avoids a cold-start latency hit on the first tool call.

const log = createLogger("memory-prefetch");

// ── In-memory prefetch store ────────────────────────────────────────
// Keyed by `${uid}:${sessionId}` → array of compact content strings.

const store = new Map<string, string[]>();

// ── SQL ──────────────────────────────────────────────────────────────

const PREFETCH_QUERY = `
  SELECT content, category, tier, created_at
  FROM (
    SELECT content::text, category, 2 AS tier, created_at
    FROM daily_notes
    WHERE uid = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
    ORDER BY created_at DESC
    LIMIT $3
  ) notes
  UNION ALL
  SELECT entity_name AS content, entity_type AS category, 4 AS tier, created_at
  FROM memory_entities
  WHERE uid = $1 AND created_at > NOW() - INTERVAL '1 day' * $2
  ORDER BY created_at DESC
  LIMIT $3
`;

interface PrefetchRow {
  content: string;
  category: string;
  tier: number;
  created_at: string | Date;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Proactively loads the user's most relevant memories from Tier 2 (daily notes)
 * and Tier 4 (graph entities) into the in-memory prefetch store for this session.
 *
 * Designed to be called fire-and-forget at session start — errors are swallowed
 * so they never block inference.
 */
export async function prefetchMemoryForSession(
  uid: string,
  agentId: string,
  sessionId: string,
  opts?: { topN?: number; ageDays?: number },
): Promise<void> {
  const storeKey = `${uid}:${sessionId}`;

  // Idempotent: skip if already prefetched for this session
  if (store.has(storeKey)) return;

  const topN = opts?.topN ?? 20;
  const ageDays = opts?.ageDays ?? 7;

  try {
    const pool = getPool();
    const result = await pool.query<PrefetchRow>(PREFETCH_QUERY, [uid, ageDays, topN]);

    const contents: string[] = [];
    for (const row of result.rows) {
      // Build a compact single-line summary for each memory row
      const tierLabel = row.tier === 2 ? "note" : "entity";
      const summary = `[${tierLabel}:${row.category}] ${String(row.content).slice(0, 200).trim()}`;
      contents.push(summary);
    }

    store.set(storeKey, contents);
    log.dim(`Prefetched ${contents.length} memories for uid=${uid} agent=${agentId} session=${sessionId}`);
  } catch (err) {
    // Never block the caller — prefetch is best-effort
    log.warn(`Prefetch failed for uid=${uid}: ${String(err)}`);
  }
}

/**
 * Returns the prefetched memory strings for a session, or an empty array
 * if the session has not been prefetched yet.
 */
export function getPrefetchedMemory(uid: string, sessionId: string): string[] {
  return store.get(`${uid}:${sessionId}`) ?? [];
}

/**
 * Removes a session's prefetch entry from the in-memory store.
 * Call when a session ends to free memory.
 */
export function clearPrefetchedMemory(uid: string, sessionId: string): void {
  store.delete(`${uid}:${sessionId}`);
}
