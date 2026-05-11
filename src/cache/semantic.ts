import { generateEmbedding } from "../memory/embeddings.js";
import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { bloomMarkAgent, bloomMayHaveEntries, bloomEvictAgent } from "./bloom-filter.js";
import { compressContent, decompressContent } from "./compression.js";
import { tagCacheEntry } from "./group-tags.js";

// ── Semantic Response Cache ──────────────────────────────────────────
// Caches LLM responses keyed by semantic similarity of the query.
// Uses pgvector cosine similarity so near-duplicate questions hit cache.
// Backed by the `semantic_cache` table created in migration 024.

const log = createLogger("semantic-cache");

export interface CachedResponse {
  content: string;
  agentId: string;
  cachedAt: number;
}

/**
 * Look up a cached response for a query. Returns null on cache miss or error.
 * @param query     - The user's query text
 * @param agentId   - Agent ID to scope the cache
 * @param threshold - Cosine similarity threshold (default: 0.97)
 */
export async function getSemanticCache(
  query: string,
  agentId: string,
  threshold = 0.97,
): Promise<CachedResponse | null> {
  if (!bloomMayHaveEntries(agentId)) return null;
  try {
    const embedding = await generateEmbedding(query);
    const vecStr = `[${embedding.join(",")}]`;

    const pool = getPool();
    const result = await pool.query<{
      content: string;
      agent_id: string;
      created_at: Date;
      compressed: boolean;
    }>(
      `SELECT content, agent_id, created_at, COALESCE(compressed, false) as compressed
       FROM semantic_cache
       WHERE agent_id = $1
         AND expires_at > NOW()
         AND 1 - (query_embedding <=> $2::vector) >= $3
       ORDER BY query_embedding <=> $2::vector
       LIMIT 1`,
      [agentId, vecStr, threshold],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0]!;
    const content = await decompressContent(row.content, row.compressed);
    return {
      content,
      agentId: row.agent_id,
      cachedAt: new Date(row.created_at).getTime(),
    };
  } catch (err) {
    // Cache miss is safe — never surface cache errors to callers
    log.dim(`Cache lookup failed (treating as miss): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Look up a cached response with stale-while-revalidate semantics.
 * Returns the cached content and whether it is stale (older than maxAgeMs / 2).
 * Returns null on cache miss or error.
 * @param queryText - The user's query text
 * @param agentId   - Agent ID to scope the cache
 * @param maxAgeMs  - Maximum age in ms; entries older than maxAgeMs/2 are considered stale
 */
export async function getStaleSemanticCache(
  queryText: string,
  agentId: string,
  maxAgeMs: number,
): Promise<{ content: string; isStale: boolean } | null> {
  try {
    const embedding = await generateEmbedding(queryText);
    const vecStr = `[${embedding.join(",")}]`;
    const threshold = 0.97;

    const pool = getPool();
    const result = await pool.query<{
      content: string;
      age_ms: string | null;
      compressed: boolean;
    }>(
      `SELECT content,
              EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000 AS age_ms,
              COALESCE(compressed, false) as compressed
       FROM semantic_cache
       WHERE agent_id = $1
         AND expires_at > NOW()
         AND 1 - (query_embedding <=> $2::vector) >= $3
       ORDER BY query_embedding <=> $2::vector
       LIMIT 1`,
      [agentId, vecStr, threshold],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0]!;
    const ageMs = row.age_ms !== null ? parseFloat(row.age_ms) : 0;
    const halfLife = maxAgeMs / 2;
    const content = await decompressContent(row.content, row.compressed);

    return {
      content,
      isStale: ageMs > halfLife,
    };
  } catch (err) {
    log.dim(`Stale cache lookup failed (treating as miss): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Delete a stale semantic cache entry by agent ID and query similarity.
 * Uses the same 0.97 threshold as the read path.
 * @param queryText - The user's query text (used to compute the embedding for matching)
 * @param agentId   - Agent ID to scope the delete
 */
export async function deleteStaleSemanticCacheEntry(
  queryText: string,
  agentId: string,
): Promise<void> {
  try {
    const embedding = await generateEmbedding(queryText);
    const vecStr = `[${embedding.join(",")}]`;
    const threshold = 0.97;

    const pool = getPool();
    await pool.query(
      `DELETE FROM semantic_cache
       WHERE agent_id = $1
         AND 1 - (query_embedding <=> $2::vector) >= $3`,
      [agentId, vecStr, threshold],
    );
  } catch (err) {
    log.dim(`Stale cache delete failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Invalidate all semantic cache entries for a given agent.
 * Called after memory writes so cached responses don't return stale context.
 * @param agentId - Agent ID whose cache entries should be purged
 * @returns Number of rows deleted
 */
export async function invalidateSemanticCacheForAgent(agentId: string): Promise<number> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM semantic_cache WHERE agent_id = $1`,
      [agentId],
    );
    bloomEvictAgent(agentId);
    return result.rowCount ?? 0;
  } catch (err) {
    log.dim(`Cache invalidation failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Invalidate semantic cache entries for an agent that are older than a given age.
 * @param agentId     - Agent ID to scope the delete
 * @param olderThanMs - Delete entries older than this many milliseconds
 * @returns Number of rows deleted
 */
export async function invalidateSemanticCacheByAge(agentId: string, olderThanMs: number): Promise<number> {
  try {
    const pool = getPool();
    const result = await pool.query(
      `DELETE FROM semantic_cache
       WHERE agent_id = $1
         AND created_at < NOW() - ($2 || ' milliseconds')::INTERVAL`,
      [agentId, olderThanMs],
    );
    return result.rowCount ?? 0;
  } catch (err) {
    log.dim(`Cache invalidation by age failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

/**
 * Store a response in the semantic cache.
 * @param query    - The user's query text
 * @param response - The LLM response to cache
 * @param agentId  - Agent ID to scope the cache
 * @param ttlMs    - TTL in milliseconds (default: 3_600_000 = 1 hour)
 * @param tags     - Optional tags for bulk invalidation grouping
 */
export async function setSemanticCache(
  query: string,
  response: string,
  agentId: string,
  ttlMs = 3_600_000,
  tags?: string[],
): Promise<void> {
  try {
    const embedding = await generateEmbedding(query);
    const vecStr = `[${embedding.join(",")}]`;

    // Compress content if enabled and beneficial
    const compressionResult =
      process.env.CACHE_COMPRESSION_ENABLED === "true"
        ? await compressContent(response)
        : { data: response, compressed: false };

    const pool = getPool();
    await pool.query(
      `INSERT INTO semantic_cache
         (query_text, query_embedding, content, compressed, agent_id, expires_at, tags)
       VALUES ($1, $2::vector, $3, $4, $5, NOW() + $6::interval, $7::text[])
       ON CONFLICT DO NOTHING`,
      [
        query,
        vecStr,
        compressionResult.data,
        compressionResult.compressed,
        agentId,
        `${ttlMs} milliseconds`,
        tags || [],
      ],
    );
    bloomMarkAgent(agentId);

    // Tag the entry if tags were provided
    if (tags && tags.length > 0) {
      await tagCacheEntry(query, agentId, tags);
    }
  } catch (err) {
    // Swallow write errors — caching is best-effort
    log.warn(`Cache write failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}
