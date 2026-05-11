// ── Swarm Shared L1 Memory Cache ────────────────────────────────────
// Shared in-memory L1 cache for swarm agents.
// All agents within the same swarmId share one cache — avoids N redundant
// memory fetches for N agents working on the same task.

const SWARM_L1_TTL_MS = 5 * 60_000; // 5 minutes — short enough to catch updates
const MAX_ENTRIES_PER_SWARM = 200;
const OLDEST_EVICTION_COUNT = 20; // number of oldest entries to remove when at capacity

export interface SwarmMemoryEntry {
  key: string;
  content: string;
  tier: number;
  score: number;
  cachedAt: number;
}

// Store: swarmId → Map<key, SwarmMemoryEntry>
const swarmCaches = new Map<string, Map<string, SwarmMemoryEntry>>();

/**
 * Retrieve a cached entry for a swarm by key.
 * Returns null if not found or if the entry has expired (TTL exceeded).
 */
export function getSwarmCache(swarmId: string, key: string): SwarmMemoryEntry | null {
  const cache = swarmCaches.get(swarmId);
  if (!cache) return null;

  const entry = cache.get(key);
  if (!entry) return null;

  // Check TTL — evict if expired
  if (Date.now() - entry.cachedAt > SWARM_L1_TTL_MS) {
    cache.delete(key);
    return null;
  }

  return entry;
}

/**
 * Store an entry in the swarm's L1 cache.
 * Evicts the oldest entries if the cache is at MAX_ENTRIES_PER_SWARM capacity.
 */
export function setSwarmCache(
  swarmId: string,
  key: string,
  entry: Omit<SwarmMemoryEntry, "cachedAt" | "key">,
): void {
  let cache = swarmCaches.get(swarmId);
  if (!cache) {
    cache = new Map<string, SwarmMemoryEntry>();
    swarmCaches.set(swarmId, cache);
  }

  // LRU eviction: if at capacity, remove the oldest entries by cachedAt
  if (cache.size >= MAX_ENTRIES_PER_SWARM) {
    const sorted = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
    for (let i = 0; i < OLDEST_EVICTION_COUNT && i < sorted.length; i++) {
      cache.delete(sorted[i]![0]);
    }
  }

  cache.set(key, { key, ...entry, cachedAt: Date.now() });
}

/**
 * Evict the entire cache for a swarm (e.g., when the swarm completes or resets).
 */
export function invalidateSwarmCache(swarmId: string): void {
  swarmCaches.delete(swarmId);
}

/**
 * Get or create the Map<key, SwarmMemoryEntry> for a swarm.
 * Useful for bulk inspection or preloading.
 */
export function getOrCreateSwarmCache(swarmId: string): Map<string, SwarmMemoryEntry> {
  let cache = swarmCaches.get(swarmId);
  if (!cache) {
    cache = new Map<string, SwarmMemoryEntry>();
    swarmCaches.set(swarmId, cache);
  }
  return cache;
}

/**
 * Return aggregate stats across all swarm caches.
 */
export function getSwarmCacheStats(): { swarmCount: number; totalEntries: number } {
  let totalEntries = 0;
  for (const cache of swarmCaches.values()) {
    totalEntries += cache.size;
  }
  return { swarmCount: swarmCaches.size, totalEntries };
}

// ── Background cleanup ───────────────────────────────────────────────
// Every 2 minutes: evict expired entries and remove empty swarm caches.

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [swarmId, cache] of swarmCaches.entries()) {
    for (const [key, entry] of cache.entries()) {
      if (now - entry.cachedAt > SWARM_L1_TTL_MS) {
        cache.delete(key);
      }
    }
    // Remove the swarm cache entirely if it's now empty
    if (cache.size === 0) {
      swarmCaches.delete(swarmId);
    }
  }
}, 2 * 60_000);

// Allow Node.js to exit without waiting for this interval
cleanupInterval.unref();
