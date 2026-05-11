import { Router } from "express";
import {
  invalidateToolCache,
  getToolCacheStats,
} from "../../inference/tool-output-cache.js";
import { getPool } from "../../config/postgres.js";

export function createToolCacheRouter(): Router {
  const router = Router();
  const pool = () => getPool();

  router.get("/tools/cache/stats", async (_req, res) => {
    const stats = await getToolCacheStats();
    res.json(stats);
  });

  router.delete("/tools/cache/:toolName", async (req, res) => {
    const { toolName } = req.params as { toolName: string };
    const count = await invalidateToolCache(toolName);
    res.json({ invalidated: count, toolName });
  });

  router.delete("/tools/cache", async (_req, res) => {
    const { rowCount } = await pool().query(`DELETE FROM tool_output_cache`);
    res.json({ cleared: rowCount ?? 0 });
  });

  return router;
}
