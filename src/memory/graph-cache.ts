// ── Graph Edge LRU Cache ────────────────────────────────────────────
// In-memory LRU cache for graph entity-relationship lookups.
// Caches the result of frequent graph traversals to avoid redundant
// Postgres + pgvector queries for the same entity pairs.
//
// Max 1000 entries, TTL 2 minutes (graph data can change frequently).
// Key: `${uid}:${entityName}:${relationType}` (all lowercased).

const MAX_SIZE = 1000;
const TTL_MS = 2 * 60 * 1000; // 2 minutes

// ── Types ────────────────────────────────────────────────────────────

export interface GraphEdgeCacheEntry {
  entities: string[];
  relations: string[];
  score: number;
  cachedAt: number;
}

// ── Internal LRU Implementation ──────────────────────────────────────
// Uses a Map which maintains insertion order, giving us LRU behaviour
// by deleting and re-inserting on access (moves to end = most recent).

interface CacheSlot {
  entry: GraphEdgeCacheEntry;
  uid: string; // stored for user-level invalidation scans
}

const lruMap = new Map<string, CacheSlot>();

// ── Stats ────────────────────────────────────────────────────────────

let hitCount = 0;
let missCount = 0;

// ── Key builder ──────────────────────────────────────────────────────

function buildKey(uid: string, entityName: string, relationType: string): string {
  return `${uid.toLowerCase()}:${entityName.toLowerCase()}:${relationType.toLowerCase()}`;
}

// ── Eviction helpers ─────────────────────────────────────────────────

/** Remove the least-recently-used entry (the first one in Map iteration order). */
function evictLRU(): void {
  const firstKey = lruMap.keys().next().value;
  if (firstKey !== undefined) {
    lruMap.delete(firstKey);
  }
}

/** Remove all expired entries regardless of LRU position. */
function pruneExpired(): void {
  const now = Date.now();
  for (const [key, slot] of lruMap) {
    if (now - slot.entry.cachedAt > TTL_MS) {
      lruMap.delete(key);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Look up a cached graph edge result.
 * Returns null on miss or if the cached entry has expired.
 */
export function getGraphEdgeCache(
  uid: string,
  entityName: string,
  relationType: string,
): GraphEdgeCacheEntry | null {
  const key = buildKey(uid, entityName, relationType);
  const slot = lruMap.get(key);

  if (!slot) {
    missCount++;
    return null;
  }

  // TTL check
  if (Date.now() - slot.entry.cachedAt > TTL_MS) {
    lruMap.delete(key);
    missCount++;
    return null;
  }

  // Move to end (most recently used)
  lruMap.delete(key);
  lruMap.set(key, slot);

  hitCount++;
  return slot.entry;
}

/**
 * Store a graph edge result in the LRU cache.
 * Evicts the least-recently-used entry when the cache is full.
 */
export function setGraphEdgeCache(
  uid: string,
  entityName: string,
  relationType: string,
  entry: GraphEdgeCacheEntry,
): void {
  const key = buildKey(uid, entityName, relationType);

  // If the key already exists, remove it first so re-insertion lands at the end
  if (lruMap.has(key)) {
    lruMap.delete(key);
  } else if (lruMap.size >= MAX_SIZE) {
    // Cache is full — prune expired entries first, then fall back to LRU eviction
    pruneExpired();
    if (lruMap.size >= MAX_SIZE) {
      evictLRU();
    }
  }

  lruMap.set(key, { entry, uid });
}

/**
 * Remove all cached entries belonging to a specific user.
 * Call when a user's graph data is modified to prevent stale reads.
 */
export function invalidateGraphEdgeCache(uid: string): void {
  const lowerUid = uid.toLowerCase();
  for (const [key, slot] of lruMap) {
    if (slot.uid.toLowerCase() === lowerUid) {
      lruMap.delete(key);
    }
  }
}

/**
 * Returns observability stats for the graph edge cache.
 */
export function getGraphCacheStats(): {
  size: number;
  maxSize: number;
  hitCount: number;
  missCount: number;
} {
  return {
    size: lruMap.size,
    maxSize: MAX_SIZE,
    hitCount,
    missCount,
  };
}
