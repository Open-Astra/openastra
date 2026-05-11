import { createLogger } from "../utils/logger.js";
import type { AgentConfig } from "../agents/types.js";

const log = createLogger("agent-config-cache");

// ── Agent Config LRU/TTL Cache ────────────────────────────────────────
// Wraps getAgentConfig() to avoid repeated DB reads for the same agent
// within a request burst. Uses insertion-order Map eviction as LRU approximation.

const TTL_MS = 60_000; // 1 minute
const MAX_SIZE = 200;

interface CacheEntry {
  config: AgentConfig;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/**
 * Retrieve a cached AgentConfig by agentId.
 * Returns undefined on miss or expiry.
 */
export function getCachedAgentConfig(agentId: string): AgentConfig | undefined {
  const entry = cache.get(agentId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(agentId);
    return undefined;
  }
  // LRU refresh: re-insert to move to end of insertion order
  cache.delete(agentId);
  cache.set(agentId, entry);
  return entry.config;
}

/**
 * Store an AgentConfig in the cache.
 * Evicts the oldest entry if the cache is at MAX_SIZE capacity.
 */
export function setCachedAgentConfig(agentId: string, config: AgentConfig): void {
  if (cache.size >= MAX_SIZE) {
    // Evict oldest (first entry by insertion order)
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(agentId, { config, expiresAt: Date.now() + TTL_MS });
}

/**
 * Explicitly invalidate a single agent config (e.g., after an update).
 */
export function invalidateCachedAgentConfig(agentId: string): void {
  cache.delete(agentId);
  log.dim(`Agent config cache invalidated: ${agentId}`);
}

/**
 * Aggregate stats for monitoring/diagnostics.
 */
export function getAgentConfigCacheStats(): { size: number; maxSize: number } {
  return { size: cache.size, maxSize: MAX_SIZE };
}
