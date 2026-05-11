import { getTurnCacheStats } from "./turn-hash-cache.js";
import { getAgentConfigCacheStats } from "../config/agent-config-cache.js";
import { getGraphCacheStats } from "../memory/graph-cache.js";
import { getSwarmCacheStats } from "../memory/swarm-l1.js";
import { getEventBus } from "../events/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("pressure-monitor");

interface CachePressureEvent {
  cacheType: string;
  fillPercent: number;
  size: number;
  maxSize: number;
  timestamp: number;
}

/**
 * Monitor all cache layers and emit pressure events when fill % exceeds 80%.
 * Called periodically (e.g., every 60 seconds) by the scheduler.
 */
export async function checkCachePressure(): Promise<void> {
  const timestamp = Date.now();
  const pressures: CachePressureEvent[] = [];

  // Check turn-hash cache
  try {
    const stats = getTurnCacheStats();
    const fillPercent = (stats.size / stats.maxSize) * 100;
    if (fillPercent > 80) {
      pressures.push({
        cacheType: "turn-hash",
        fillPercent,
        size: stats.size,
        maxSize: stats.maxSize,
        timestamp,
      });
    }
  } catch (err) {
    log.warn(`Failed to check turn cache pressure: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check agent config cache
  try {
    const stats = getAgentConfigCacheStats();
    const fillPercent = (stats.size / stats.maxSize) * 100;
    if (fillPercent > 80) {
      pressures.push({
        cacheType: "agent-config",
        fillPercent,
        size: stats.size,
        maxSize: stats.maxSize,
        timestamp,
      });
    }
  } catch (err) {
    log.warn(`Failed to check agent config cache pressure: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check graph cache
  try {
    const stats = getGraphCacheStats();
    const maxSize = 10000; // Estimate max as 10k entries
    const fillPercent = (stats.size / maxSize) * 100;
    if (fillPercent > 80) {
      pressures.push({
        cacheType: "graph",
        fillPercent,
        size: stats.size,
        maxSize,
        timestamp,
      });
    }
  } catch (err) {
    log.warn(`Failed to check graph cache pressure: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check swarm L1 cache
  try {
    const stats = getSwarmCacheStats();
    const maxSize = 5000; // Estimate max as 5k entries
    const fillPercent = (stats.totalEntries / maxSize) * 100;
    if (fillPercent > 80) {
      pressures.push({
        cacheType: "swarm-l1",
        fillPercent,
        size: stats.totalEntries,
        maxSize,
        timestamp,
      });
    }
  } catch (err) {
    log.warn(`Failed to check swarm cache pressure: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Emit pressure events for each cache layer exceeding threshold
  const eventBus = getEventBus();
  for (const event of pressures) {
    try {
      eventBus.emit("cache.pressure", event);
      log.warn(
        `Cache pressure detected: ${event.cacheType} at ${event.fillPercent.toFixed(1)}% (${event.size}/${event.maxSize})`,
      );
    } catch (err) {
      log.warn(`Failed to emit cache pressure event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
