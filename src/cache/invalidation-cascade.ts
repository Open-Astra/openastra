import { invalidateGraphEdgeCache } from "../memory/graph-cache.js";
import { invalidateSwarmCache } from "../memory/swarm-l1.js";
import { invalidateSemanticCacheForAgent } from "./semantic.js";
import { clearPrefetchedMemory } from "../memory/prefetch.js";
import { notifyInvalidation } from "./invalidation-bus.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("invalidation-cascade");

export interface CascadeOptions {
  /** Agent whose semantic cache should be cleared */
  agentId?: string;
  /** User ID — used to evict graph edges and prefetch store */
  uid?: string;
  /** Session ID — used to evict prefetch store */
  sessionId?: string;
  /** Swarm ID — used to evict swarm L1 cache */
  swarmId?: string;
}

/**
 * Cascade cache invalidation across all layers.
 *
 * Call this after any write that could stale cached data:
 *   - memory writes
 *   - graph entity updates
 *   - agent config changes
 *
 * Order: L1 (in-process) → L2 (semantic DB) — always evict fast caches first.
 */
export async function cascadeInvalidation(opts: CascadeOptions): Promise<void> {
  const { agentId, uid, sessionId, swarmId } = opts;

  // L1: evict in-process caches immediately
  if (uid) {
    invalidateGraphEdgeCache(uid);
    log.dim(`L1 graph cache evicted for uid ${uid}`);
  }

  if (swarmId) {
    invalidateSwarmCache(swarmId);
    log.dim(`L1 swarm cache evicted for swarmId ${swarmId}`);
  }

  if (uid && sessionId) {
    clearPrefetchedMemory(uid, sessionId);
    log.dim(`L1 prefetch evicted for session ${sessionId}`);
  }

  // L2: evict semantic cache (async DB op)
  if (agentId) {
    await invalidateSemanticCacheForAgent(agentId);
    log.dim(`L2 semantic cache evicted for agent ${agentId}`);
  }

  // Notify other processes via PG LISTEN/NOTIFY (fire-and-forget)
  if (process.env.CACHE_INVALIDATION_BUS_ENABLED === "true") {
    notifyInvalidation(opts).catch((err) => {
      log.dim(`Notification send failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

/**
 * Fire-and-forget cascade (for use in hot paths where you don't want to await).
 */
export function cascadeInvalidationAsync(opts: CascadeOptions): void {
  cascadeInvalidation(opts).catch((err) => {
    log.warn(`Cascade invalidation error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  });
}
