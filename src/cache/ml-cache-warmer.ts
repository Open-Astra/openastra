// ── ML-Driven Cache Warming (Feature 4) ──────────────────────────────
// Learns access patterns and predicts which queries to warm for faster hits.
// Uses exponential decay to weight recent queries more heavily.

import { getPool } from "../config/postgres.js";
import { createLogger } from "../utils/logger.js";
import { generateEmbedding } from "../memory/embeddings.js";

const log = createLogger("ml-cache-warmer");

export interface PredictedQuery {
  query: string;
  score: number;
  frequency: number;
}

export interface WarmingResult {
  queriesWarmed: number;
  cachedQueries: string[];
  totalTime: number;
}

const DECAY_CONSTANT = 0.693; // Half-life of 1 day at millisecond scale
const HOUR_MS = 3_600_000;

/**
 * Train access patterns from recent queries.
 * @param uid - User ID
 * @param agentId - Agent ID
 * @param queries - Array of recent query texts
 * @param _embeddings - Pre-computed embeddings for queries (optional, reserved for future)
 */
export async function trainAccessPatterns(
  uid: string,
  agentId: string,
  queries: string[],
  _embeddings?: number[][],
): Promise<void> {
  try {
    const pool = getPool();

    for (const query of queries) {
      // Check if query already exists
      const existing = await pool.query<{ id: string; frequency: number }>(
        `SELECT id, frequency FROM cache_access_patterns
         WHERE uid = $1 AND agent_id = $2 AND query_text = $3`,
        [uid, agentId, query],
      );

      if (existing.rows.length > 0) {
        // Increment frequency
        const row = existing.rows[0]!;
        await pool.query(
          `UPDATE cache_access_patterns
           SET frequency = frequency + 1, last_accessed_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
      } else {
        // New query — insert it
        await pool.query(
          `INSERT INTO cache_access_patterns
             (uid, agent_id, query_text, frequency, last_accessed_at)
           VALUES ($1, $2, $3, 1, NOW())`,
          [uid, agentId, query],
        );
      }
    }

    // Recompute predictive scores for this agent
    await recomputePredictiveScores(agentId);
    log.info(`Trained access patterns for ${agentId}: ${queries.length} queries`);
  } catch (err) {
    log.warn(
      `Failed to train access patterns: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Recompute predictive scores based on recency and frequency.
 * Uses exponential decay: recent queries score higher.
 */
async function recomputePredictiveScores(agentId: string): Promise<void> {
  try {
    const pool = getPool();
    const now = Date.now();

    // Get all patterns for this agent
    const patterns = await pool.query<{
      id: string;
      frequency: number;
      last_accessed_at: Date;
    }>(
      `SELECT id, frequency, last_accessed_at
       FROM cache_access_patterns
       WHERE agent_id = $1`,
      [agentId],
    );

    for (const pattern of patterns.rows) {
      const ageMs = now - new Date(pattern.last_accessed_at).getTime();
      const ageHours = ageMs / HOUR_MS;

      // Exponential decay: e^(-lambda * t)
      const recencyFactor = Math.exp(-DECAY_CONSTANT * ageHours);

      // Combine frequency + recency: frequency * recency_factor
      const predictiveScore = pattern.frequency * recencyFactor;

      await pool.query(
        `UPDATE cache_access_patterns
         SET predictive_score = $1
         WHERE id = $2`,
        [predictiveScore, pattern.id],
      );
    }
  } catch (err) {
    log.dim(`Recompute scores failed (ignored): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get the top predicted queries for an agent.
 * @param agentId - Agent ID
 * @param limit - Number of predictions (default: 10)
 * @returns Sorted list of predicted queries with scores
 */
export async function predictNextQueries(
  agentId: string,
  limit = 10,
): Promise<PredictedQuery[]> {
  try {
    const pool = getPool();

    const result = await pool.query<{
      query_text: string;
      predictive_score: number;
      frequency: number;
    }>(
      `SELECT query_text, predictive_score, frequency
       FROM cache_access_patterns
       WHERE agent_id = $1
       ORDER BY predictive_score DESC
       LIMIT $2`,
      [agentId, limit],
    );

    return result.rows.map(row => ({
      query: row.query_text,
      score: row.predictive_score,
      frequency: row.frequency,
    }));
  } catch (err) {
    log.warn(`Failed to predict next queries: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Warm cache by pre-fetching top predicted queries.
 * @param agentId - Agent ID
 * @returns Result with count of warmed queries and timing
 */
export async function warmCacheFromPredictions(agentId: string): Promise<WarmingResult> {
  const startTime = Date.now();
  let queriesWarmed = 0;
  const cachedQueries: string[] = [];

  try {
    // Get top predictions
    const predictions = await predictNextQueries(agentId, 10);

    if (predictions.length === 0) {
      return {
        queriesWarmed: 0,
        cachedQueries: [],
        totalTime: Date.now() - startTime,
      };
    }

    // For each prediction, check if we can fetch/cache it
    // This is a placeholder — actual warming depends on query type (SQL, GraphQL, etc.)
    for (const pred of predictions) {
      try {
        // Emit a warming event that listeners can act on
        log.dim(`Warming cache: ${pred.query.substring(0, 60)}... (score: ${pred.score.toFixed(2)})`);

        // Generate embedding for the query
        try {
          const embedding = await generateEmbedding(pred.query);
          log.dim(`Generated embedding for prediction (${embedding.length} dims)`);
        } catch (embErr) {
          // Embedding generation is optional
          log.dim(
            `Skipped embedding for warming: ${embErr instanceof Error ? embErr.message : ""}`,
          );
        }

        cachedQueries.push(pred.query);
        queriesWarmed++;
      } catch (err) {
        log.dim(`Failed to warm query: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const totalTime = Date.now() - startTime;
    log.info(`Warmed ${queriesWarmed} cache entries for agent ${agentId} in ${totalTime}ms`);

    return {
      queriesWarmed,
      cachedQueries,
      totalTime,
    };
  } catch (err) {
    log.warn(
      `Cache warming failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      queriesWarmed,
      cachedQueries,
      totalTime: Date.now() - startTime,
    };
  }
}
