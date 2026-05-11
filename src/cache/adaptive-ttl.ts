import { createLogger } from "../utils/logger.js";

const log = createLogger("adaptive-ttl");

// ── Adaptive TTL ──────────────────────────────────────────────────────
// Dynamically adjusts semantic cache TTL based on per-key hit rate.
// Frequently-hit entries get longer TTL; rarely-hit entries expire sooner.

// Track hit counts per (agentId:queryHash) within a rolling window
interface HitRecord {
  hits: number;
  windowStart: number;
}

const hitMap = new Map<string, HitRecord>();
const WINDOW_MS = 10 * 60_000; // 10-minute window
const BASE_TTL_MS = 3_600_000;  // 1 hour base
const MAX_TTL_MS = 7_200_000;   // 2 hour cap
const MIN_TTL_MS = 600_000;     // 10 minute floor

/**
 * Record a cache hit and compute the adaptive TTL for the next write.
 * Returns the recommended TTL in milliseconds.
 */
export function recordHitAndGetTtl(key: string): number {
  const now = Date.now();
  const record = hitMap.get(key);

  if (!record || now - record.windowStart > WINDOW_MS) {
    hitMap.set(key, { hits: 1, windowStart: now });
    return BASE_TTL_MS;
  }

  record.hits++;
  const ttl = Math.min(BASE_TTL_MS * (1 + Math.log2(record.hits) * 0.5), MAX_TTL_MS);
  log.dim(`Adaptive TTL for ${key}: ${Math.round(ttl / 1000)}s (${record.hits} hits in window)`);
  return ttl;
}

/**
 * Get the recommended TTL for a cache miss (cold path — use base TTL).
 */
export function getBaseTtl(): number {
  return BASE_TTL_MS;
}

/**
 * Get the minimum TTL (for infrequently-accessed entries).
 */
export function getMinTtl(): number {
  return MIN_TTL_MS;
}

// Periodic cleanup of stale window records
const pruneInterval = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, v] of hitMap) {
    if (v.windowStart < cutoff) hitMap.delete(k);
  }
}, WINDOW_MS);
if (pruneInterval.unref) pruneInterval.unref();
