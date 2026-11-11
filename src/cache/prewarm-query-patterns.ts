import { getPool } from "../config/postgres.js";
import { generateEmbedding } from "../memory/embeddings.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("prewarm-query-patterns");

/**
 * Preload high-hit semantic cache entries into process memory.
 * Queries recent cache entries by hit count and attempts to regenerate their embeddings.
 * This reduces latency for frequently-accessed query patterns.
 * @param agentId - Optional: filter to specific agent; if not provided, preheats all agents' patterns
 */
export async function prewarmFromPatterns(agentId?: string): Promise<void> {
  try {
    const pool = getPool();

    // Query top 50 most-hit cache entries
    const whereClause = agentId ? "WHERE agent_id = $1" : "";
    const params = agentId ? [agentId] : [];

    const result = await pool.query<{
      query_text: string;
      agent_id: string;
      hit_count: number;
    }>(
      `SELECT query_text, agent_id, COALESCE((SELECT COUNT(*) FROM semantic_cache WHERE query_text = sc.query_text), 0)::int AS hit_count
       FROM semantic_cache sc
       ${whereClause}
       GROUP BY query_text, agent_id
       ORDER BY hit_count DESC
       LIMIT 50`,
      params,
    );

    let preheated = 0;
    for (const row of result.rows) {
      try {
        // Warm the embedding cache only. Never write synthetic responses into
        // the semantic cache — a placeholder would be served as a real answer.
        await generateEmbedding(row.query_text);
        preheated++;
      } catch (err) {
        log.dim(
          `Failed to preload pattern "${row.query_text}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    log.info(`Prewarmed ${preheated} query patterns${agentId ? ` for agent ${agentId}` : ""}`);
  } catch (err) {
    log.warn(`Cache prewarming failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
