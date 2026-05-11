// ── Tool Result Cache ──────────────────────────────────────────────
// In-memory LRU cache for expensive tool results. Tools can opt-in
// to caching by name. Cache keys are derived from tool name + params.
//
// This prevents redundant API calls when the agent retries or
// re-invokes the same tool with identical parameters.

import { createHash } from "node:crypto";

interface CacheEntry {
  result: string;
  cachedAt: number;
  hitCount: number;
}

export const DEFAULT_TTL_MS = 5 * 60_000; // 5 minutes
const MAX_ENTRIES = 500;

// Tool-specific TTL overrides (ms)
export const TOOL_TTLS: Record<string, number> = {
  prop_lookup: 60_000,       // 1 min — odds change frequently
  line_compare: 60_000,      // 1 min
  x_search: 2 * 60_000,     // 2 min
  model_inference: 5 * 60_000, // 5 min — model results are stable
  brave_search: 3 * 60_000,   // 3 min
  memory_search: 30_000,       // 30s — memory can change within session
  sql_query: 60_000,           // 1 min
};

// Tools that should never be cached (side-effects, writes)
const NEVER_CACHE = new Set([
  "memory_write",
  "knowledge_ingest",
  "knowledge_delete",
  "push_notify",
  "send_email",
  "send_webhook",
  "agent_spawn",
  "file_write",
  "shell_execute",
  "auto_extract_facts",
  "auto_save_summary",
  "run_workflow",
  "run_parallel_steps",
  "run_procedure",
  "find_and_run_procedure",
  "memory_consolidate_daily",
  "memory_promote_themes",
  "memory_decay_graph",
  "memory_consolidate_full",
  "vector_ingest",
  "vector_batch_ingest",
  "vector_create_collection",
]);

const cache = new Map<string, CacheEntry>();

function cacheKey(toolName: string, args: string): string {
  const hash = createHash("sha256").update(`${toolName}:${args}`).digest("hex").slice(0, 16);
  return `${toolName}:${hash}`;
}

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    const toolName = key.split(":")[0]!;
    const ttl = TOOL_TTLS[toolName] ?? DEFAULT_TTL_MS;
    if (now - entry.cachedAt > ttl) {
      cache.delete(key);
    }
  }
}

function evictLRU(): void {
  if (cache.size <= MAX_ENTRIES) return;

  // Remove oldest entries first
  const entries = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt);
  const toRemove = entries.slice(0, cache.size - MAX_ENTRIES);
  for (const [key] of toRemove) {
    cache.delete(key);
  }
}

export function shouldCache(toolName: string): boolean {
  return !NEVER_CACHE.has(toolName);
}

export function getCachedResult(toolName: string, args: string): string | null {
  if (!shouldCache(toolName)) return null;

  const key = cacheKey(toolName, args);
  const entry = cache.get(key);
  if (!entry) return null;

  const ttl = TOOL_TTLS[toolName] ?? DEFAULT_TTL_MS;
  if (Date.now() - entry.cachedAt > ttl) {
    cache.delete(key);
    return null;
  }

  entry.hitCount++;
  return entry.result;
}

export function setCachedResult(toolName: string, args: string, result: string): void {
  if (!shouldCache(toolName)) return;

  // Periodic cleanup
  if (cache.size > MAX_ENTRIES * 0.9) {
    evictExpired();
    evictLRU();
  }

  const key = cacheKey(toolName, args);
  cache.set(key, {
    result,
    cachedAt: Date.now(),
    hitCount: 0,
  });
}

export function getCacheStats(): {
  size: number;
  maxEntries: number;
  tools: Record<string, { entries: number; hits: number }>;
} {
  const tools: Record<string, { entries: number; hits: number }> = {};

  for (const [key, entry] of cache) {
    const toolName = key.split(":")[0]!;
    if (!tools[toolName]) {
      tools[toolName] = { entries: 0, hits: 0 };
    }
    tools[toolName]!.entries++;
    tools[toolName]!.hits += entry.hitCount;
  }

  return { size: cache.size, maxEntries: MAX_ENTRIES, tools };
}

export function clearCache(toolName?: string): number {
  if (!toolName) {
    const count = cache.size;
    cache.clear();
    return count;
  }

  let cleared = 0;
  for (const key of cache.keys()) {
    if (key.startsWith(`${toolName}:`)) {
      cache.delete(key);
      cleared++;
    }
  }
  return cleared;
}
