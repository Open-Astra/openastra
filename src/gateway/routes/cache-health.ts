import { Router } from "express";
import { getGraphCacheStats } from "../../memory/graph-cache.js";
import { getSwarmCacheStats } from "../../memory/swarm-l1.js";
import { getNegativeCacheStats } from "../../memory/tiered-search.js";
import { getReadThroughCacheStats } from "../../memory/read-through.js";
import { bloomStats } from "../../cache/bloom-filter.js";
import { getAgentConfigCacheStats } from "../../config/agent-config-cache.js";
import { getTurnCacheStats } from "../../cache/turn-hash-cache.js";

export function createCacheHealthRouter(): Router {
  const router = Router();

  // GET /cache/health — lightweight stats from all in-process caches (no DB I/O)
  router.get("/health", (_req, res) => {
    const stats = {
      graphEdge: getGraphCacheStats(),
      swarmL1: getSwarmCacheStats(),
      negativeResult: getNegativeCacheStats(),
      readThrough: getReadThroughCacheStats(),
      bloom: bloomStats(),
      agentConfig: getAgentConfigCacheStats(),
      turnHash: getTurnCacheStats(),
      timestamp: new Date().toISOString(),
    };
    res.json(stats);
  });

  return router;
}
