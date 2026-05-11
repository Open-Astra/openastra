import { createLogger } from "../utils/logger.js";

const log = createLogger("bloom-filter");

// Set of agentIds that have at least one active semantic cache entry.
// A miss here means "definitely no entries" — safe to skip DB lookup.
// A hit means "probably has entries" — proceed with normal lookup.
const agentBloom = new Set<string>();

/**
 * Record that an agent has at least one cache entry.
 * Call this whenever setSemanticCache succeeds.
 */
export function bloomMarkAgent(agentId: string): void {
  agentBloom.add(agentId);
}

/**
 * Check whether an agent MIGHT have cache entries.
 * Returns false (definitely empty) → skip semantic cache lookup entirely.
 * Returns true  (possibly has entries) → proceed with embedding + pgvector.
 */
export function bloomMayHaveEntries(agentId: string): boolean {
  return agentBloom.has(agentId);
}

/**
 * Remove an agent from the bloom filter (call after full cache invalidation).
 * After this, the next lookup will skip the DB until a new entry is written.
 */
export function bloomEvictAgent(agentId: string): void {
  agentBloom.delete(agentId);
  log.dim(`Bloom filter: evicted ${agentId}`);
}

/**
 * Evict all entries (e.g., after mass cache clear).
 */
export function bloomReset(): void {
  const count = agentBloom.size;
  agentBloom.clear();
  log.dim(`Bloom filter: reset (${count} agents cleared)`);
}

export function bloomStats(): { agentsTracked: number } {
  return { agentsTracked: agentBloom.size };
}
