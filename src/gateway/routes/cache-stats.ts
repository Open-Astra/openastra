import { Router } from "express";
import { getPool } from "../../config/postgres.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("cache-stats-route");

export function createCacheStatsRouter(): Router {
  const router = Router();

  // GET /cache/stats — aggregate stats from all cache layers
  router.get("/stats", async (_req, res) => {
    try {
      const pool = getPool();

      // Semantic cache stats
      const semanticResult = await pool.query<{
        total_entries: string;
        expired_entries: string;
        agents: string;
      }>(
        `SELECT
           COUNT(*) AS total_entries,
           COUNT(*) FILTER (WHERE expires_at <= NOW()) AS expired_entries,
           COUNT(DISTINCT agent_id) AS agents
         FROM semantic_cache`,
      );

      // Provider cache metrics (last 24h)
      const metricsResult = await pool.query<{
        provider: string;
        cached_tokens: string;
        prompt_tokens: string;
        avg_hit_rate: string;
      }>(
        `SELECT
           provider,
           SUM(cached_tokens) AS cached_tokens,
           SUM(prompt_tokens) AS prompt_tokens,
           AVG(hit_rate) AS avg_hit_rate
         FROM provider_cache_metrics
         WHERE recorded_at > NOW() - INTERVAL '24 hours'
         GROUP BY provider
         ORDER BY cached_tokens DESC`,
      );

      // Embedding cache stats
      const embeddingResult = await pool.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM embedding_cache`,
      );

      const semantic = semanticResult.rows[0]!;
      const embedding = embeddingResult.rows[0]!;

      res.json({
        semantic: {
          totalEntries: Number(semantic.total_entries),
          expiredEntries: Number(semantic.expired_entries),
          activeEntries: Number(semantic.total_entries) - Number(semantic.expired_entries),
          agents: Number(semantic.agents),
        },
        providers: metricsResult.rows.map(r => ({
          provider: r.provider,
          cachedTokens: Number(r.cached_tokens),
          promptTokens: Number(r.prompt_tokens),
          avgHitRate: Number(r.avg_hit_rate),
          savedTokens: Number(r.cached_tokens),
        })),
        embedding: {
          totalEntries: Number(embedding.total),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      log.error(`Cache stats error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to retrieve cache stats" });
    }
  });

  // DELETE /cache/stats/expired — purge expired entries
  router.delete("/stats/expired", async (_req, res) => {
    try {
      const pool = getPool();
      const result = await pool.query(
        `DELETE FROM semantic_cache WHERE expires_at <= NOW()`,
      );
      res.json({ deleted: result.rowCount ?? 0 });
    } catch (err) {
      log.error(`Cache purge error: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ error: "Failed to purge expired entries" });
    }
  });

  return router;
}
