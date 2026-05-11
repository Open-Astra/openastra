// ── Memory L1 Read-Through Cache ───────────────────────────────────────
// In-process LRU cache for hot memory lookups; TTL-backed invalidation.

import { createLogger } from "../utils/logger.js";

const logger = createLogger("memory-l1-cache");

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  hits: number;
}

export class MemoryL1Cache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 512, ttlMs = 30_000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    entry.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    if (this.store.size >= this.maxSize) {
      this.evictLRU();
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.ttlMs),
      hits: 0,
    });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): number {
    let count = 0;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) {
        this.store.delete(k);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }

  stats(): { size: number; hitRatio: string } {
    let totalHits = 0;
    let totalEntries = 0;
    for (const entry of this.store.values()) {
      totalHits += entry.hits;
      totalEntries++;
    }
    const ratio = totalEntries > 0 ? (totalHits / totalEntries).toFixed(2) : "0.00";
    return { size: totalEntries, hitRatio: ratio };
  }

  private evictLRU(): void {
    // Evict expired entries first
    const now = Date.now();
    for (const [k, v] of this.store.entries()) {
      if (now > v.expiresAt) {
        this.store.delete(k);
        return;
      }
    }
    // Evict least-hit entry
    let lhKey: string | null = null;
    let lhHits = Infinity;
    for (const [k, v] of this.store.entries()) {
      if (v.hits < lhHits) { lhHits = v.hits; lhKey = k; }
    }
    if (lhKey) this.store.delete(lhKey);
  }
}

/** Singleton L1 cache instances for common memory tables. */
export const dailyMemoryCache = new MemoryL1Cache<unknown[]>(256, 20_000);
export const graphEntityCache = new MemoryL1Cache<unknown>(512, 30_000);
export const userProfileCache = new MemoryL1Cache<unknown>(128, 60_000);

/** Wrap an async loader with L1 read-through caching. */
export async function withL1Cache<T>(
  cache: MemoryL1Cache<T>,
  key: string,
  loader: () => Promise<T>,
  ttlMs?: number,
): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const value = await loader();
  cache.set(key, value, ttlMs);
  return value;
}

logger.info("Memory L1 cache module loaded");
